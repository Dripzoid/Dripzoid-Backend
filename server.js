// backend/server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import crypto from "crypto";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import { v2 as cloudinary } from "cloudinary";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { UAParser } from "ua-parser-js";
import cookieParser from "cookie-parser";

// Import routes
import wishlistRoutes from "./wishlist.js";
import productsRouter from "./products.js";
import cartRouter from "./cart.js";
import adminProductsRoutes from "./adminProducts.js";
import { auth } from "./auth.js";
import adminStatsRoutes from "./adminStats.js";
import orderRoutes from "./orderRoutes.js";
import uploadRoutes from "./uploadRoutes.js";
import featuredRoutes from "./featuredRoutes.js";
import userOrdersRoutes from "./userOrders.js";
import addressRoutes from "./address.js";
import paymentsRouter from "./payments.js";
import accountSettingsRoutes from "./accountSettings.js";
import adminOrdersRoutes from "./adminOrders.js";
import reviewsRouter from "./reviews.js";
import qaRouter from "./qa.js";
import votesRouter from "./votes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const API_BASE = process.env.API_BASE || "http://localhost:5000";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

const app = express();

// ----------- Middleware -----------

// Trust proxy if behind load balancer
if (process.env.TRUST_PROXY === "1" || process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// CORS
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors()); // handle preflight

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Cloudinary (optional)
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// ----------- Database -----------

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data/dripzoid.db");
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ SQLite connection error:", err.message);
  else console.log("✅ Connected to SQLite database at", DB_PATH);
});
app.locals.db = db;

// Create tables if missing
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device TEXT,
      ip TEXT,
      last_active TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT,
      device TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
});

// ----------- Helpers -----------

function getDevice(req) {
  try {
    const parser = new UAParser(req.headers["user-agent"]);
    const device = parser.getDevice().model || parser.getOS().name || "Unknown Device";
    const browser = parser.getBrowser().name || "";
    return `${device} ${browser}`.trim();
  } catch {
    return "Unknown Device";
  }
}

function getIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return xf.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "Unknown IP";
}

const TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // 180 days
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: TOKEN_MAX_AGE_MS,
};

// ----------- JWT Middleware -----------

function authenticateToken(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers["authorization"];
    if (authHeader?.toLowerCase().startsWith("bearer ")) token = authHeader.split(" ")[1];
    else if (req.cookies?.token) token = req.cookies.token;

    if (!token) return res.status(401).json({ message: "No token provided" });

    jwt.verify(token, JWT_SECRET, (err, payload) => {
      if (err) return res.status(403).json({ message: "Invalid or expired token" });
      req.user = payload;
      next();
    });
  } catch (err) {
    console.error("authenticateToken error:", err);
    return res.status(500).json({ message: "Authentication error" });
  }
}

// ----------- Passport Google OAuth -----------

app.use(passport.initialize());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      callbackURL: `${API_BASE.replace(/\/$/, "")}/api/auth/google/callback`,
      passReqToCallback: true,
    },
    (req, accessToken, refreshToken, profile, done) => {
      const user = {
        googleId: profile.id,
        name: profile.displayName || "",
        email: profile.emails?.[0]?.value || null,
        avatar: profile.photos?.[0]?.value || null,
      };
      return done(null, user);
    }
  )
);

// ----------- Token Issuance -----------

function issueTokenAndRespond(req, res, userId, email, name = "", isAdmin = 0, isOAuth = false, activityType = "login") {
  try {
    const token = jwt.sign({ id: userId, email, is_admin: isAdmin }, JWT_SECRET, { expiresIn: "180d" });

    const device = getDevice(req);
    const ip = getIP(req);
    const now = new Date().toISOString();

    db.run(
      "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
      [userId, device, ip, now],
      function (err2) {
        if (err2) return res.status(500).json({ message: "Failed to create session" });

        const sessionId = this.lastID;

        // Log activity
        db.run(
          "INSERT INTO user_activity (user_id, type, device, ip, created_at) VALUES (?, ?, ?, ?, ?)",
          [userId, activityType, device, ip, now]
        );

        // Set cookies
        res.cookie("token", token, AUTH_COOKIE_OPTIONS);
        res.cookie("sessionId", String(sessionId), AUTH_COOKIE_OPTIONS);

        // Redirect to frontend
        return res.redirect(`${CLIENT_URL}/account`);
      }
    );
  } catch (err) {
    console.error("Token issuance failed:", err);
    return res.status(500).json({ message: "Failed to issue token" });
  }
}

// ----------- Auth Routes -----------

// Google OAuth
app.get("/api/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/api/auth/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${CLIENT_URL}/login?error=google_auth_failed` }),
  async (req, res) => {
    try {
      const email = req.user?.email?.toLowerCase();
      if (!email) return res.redirect(`${CLIENT_URL}/login?error=no_email`);

      db.get("SELECT * FROM users WHERE lower(email) = ?", [email], async (err, row) => {
        if (err) return res.redirect(`${CLIENT_URL}/login?error=db_error`);

        if (!row) {
          const safeName = req.user.name || email.split("@")[0];
          const randomPassword = crypto.randomBytes(16).toString("hex");
          const hashedPassword = await bcrypt.hash(randomPassword, 10);

          db.run(
            "INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)",
            [safeName, email, null, hashedPassword],
            function (insertErr) {
              if (insertErr) return res.redirect(`${CLIENT_URL}/login?error=user_create_failed`);
              return issueTokenAndRespond(req, res, this.lastID, email, safeName);
            }
          );
        } else {
          return issueTokenAndRespond(req, res, row.id, email, row.name || req.user.name, Number(row.is_admin));
        }
      });
    } catch (err) {
      console.error("Google callback error:", err);
      return res.redirect(`${CLIENT_URL}/login?error=oauth_failed`);
    }
  }
);

// Register
app.post("/api/register", async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password) return res.status(400).json({ message: "All fields are required" });

  const normalizedEmail = email.toLowerCase();
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      "INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)",
      [name, normalizedEmail, phone, hashedPassword],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) return res.status(400).json({ message: "Email already exists" });
          return res.status(500).json({ message: err.message || "Failed to register" });
        }
        return issueTokenAndRespond(req, res, this.lastID, normalizedEmail, name, 0, false, "register");
      }
    );
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Login
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = email.toLowerCase();

  db.get("SELECT * FROM users WHERE lower(email) = ?", [normalizedEmail], async (err, row) => {
    if (err) return res.status(500).json({ message: err.message });
    if (!row) return res.status(401).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, row.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid password" });

    return issueTokenAndRespond(req, res, row.id, row.email, row.name, Number(row.is_admin), false, "login");
  });
});

// /api/auth/me
app.get("/api/auth/me", authenticateToken, (req, res) => {
  const userId = Number(req.user?.id);
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [userId], (err, userRow) => {
    if (err || !userRow) return res.status(500).json({ message: "DB error or user not found" });

    const token = jwt.sign({ id: userRow.id, email: userRow.email, is_admin: userRow.is_admin }, JWT_SECRET, { expiresIn: "180d" });
    res.cookie("token", token, AUTH_COOKIE_OPTIONS);

    res.json({ user: userRow });
  });
});

// ----------- Mount other routes -----------

app.use("/api/wishlist", wishlistRoutes);
app.use("/api/products", productsRouter);
app.use("/api/cart", cartRouter);
app.use("/api/orders", orderRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/user/orders", authenticateToken, userOrdersRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/payments", paymentsRouter);
app.use("/api/account", accountSettingsRoutes);
app.use("/api/featured", featuredRoutes);
app.use("/api/admin/products", auth, adminProductsRoutes);
app.use("/api/admin/orders", auth, adminOrdersRoutes);
app.use("/api/admin", auth, adminStatsRoutes);
app.use("/api/reviews", reviewsRouter);
app.use("/api/qa", qaRouter);
app.use("/api/votes", votesRouter);

// Health check
app.get("/test-env", (req, res) => {
  res.json({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || null,
    apiKey: !!process.env.CLOUDINARY_API_KEY,
    apiSecret: !!process.env.CLOUDINARY_API_SECRET,
    nodeEnv: process.env.NODE_ENV || "development",
  });
});

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ message: "API route not found" });
  res.status(404).send("Not Found");
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

export { app, db };
