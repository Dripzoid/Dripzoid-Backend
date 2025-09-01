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
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { UAParser } from "ua-parser-js";

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

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const API_BASE = process.env.API_BASE || "http://localhost:5000";
const JWT_SECRET = process.env.JWT_SECRET || "Dripzoid.App@2025";

const app = express();

// CORS
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cloudinary
if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} else {
  console.warn("⚠️ Cloudinary env vars not fully set.");
}

// SQLite DB
const dbPath = path.join(__dirname, "dripzoid.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ SQLite connection error:", err.message);
  else console.log("✅ Connected to SQLite database at", dbPath);
});
app.locals.db = db;

// ---------- Helpers ----------
function getDevice(req) {
  const parser = new UAParser(req.headers["user-agent"]);
  const device = parser.getDevice().model || parser.getOS().name || "Unknown Device";
  const browser = parser.getBrowser().name || "";
  return `${device} ${browser}`.trim();
}
function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress || "Unknown IP";
}

// JWT middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ message: "No token provided" });
  if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ message: "Invalid token format" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid or expired token" });
    req.user = user;
    next();
  });
}

// ---------- OAuth ----------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "google-oauth-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      callbackURL: `${API_BASE}/api/auth/google/callback`,
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

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

function issueTokenAndRespond(res, req, userId, email, name = "", isAdmin = 0, isOAuth = false) {
  try {
    const token = jwt.sign({ id: userId, email, is_admin: isAdmin }, JWT_SECRET, { expiresIn: "180d" });
    const device = getDevice(req);
    const ip = getIP(req);
    const lastActive = new Date().toISOString();

    db.run(
      "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
      [userId, device, ip, lastActive],
      function (err2) {
        if (err2) {
          console.error("Failed to insert session:", err2.message);
          if (isOAuth) return res.redirect(`${CLIENT_URL}/login?error=session_create_failed`);
          return res.status(500).json({ message: "Failed to create session" });
        }

        const sessionId = this.lastID;

        if (isOAuth) {
          const url = new URL("/account", CLIENT_URL);
          const params = new URLSearchParams({ token, sessionId: String(sessionId) });
          if (name) params.set("name", name);
          url.search = params.toString();
          return res.redirect(url.toString());
        } else {
          return res.json({
            message: "Success",
            token,
            sessionId,
            user: { id: userId, name, email, phone: null, is_admin: isAdmin },
          });
        }
      }
    );
  } catch (err) {
    console.error("Token issuance failed:", err);
    if (isOAuth) return res.redirect(`${CLIENT_URL}/login?error=token_issue_failed`);
    return res.status(500).json({ message: "Failed to issue token" });
  }
}

// ---------- Google OAuth routes ----------
app.get("/api/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/api/auth/google/callback",
  passport.authenticate("google", { failureRedirect: `${CLIENT_URL}/login?error=google_auth_failed` }),
  async (req, res) => {
    try {
      const email = req.user?.email;
      const nameFromGoogle = (req.user?.name || "").trim();

      if (!email) return res.redirect(`${CLIENT_URL}/login?error=missing_email`);

      // Wrap SQLite get in a promise
      const getUser = () =>
        new Promise((resolve, reject) => {
          db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
            if (err) return reject(err);
            resolve(row);
          });
        });

      let row = await getUser();

      if (!row) {
        const safeName = nameFromGoogle || email.split("@")[0];
        const randomPassword = crypto.randomBytes(16).toString("hex");
        const hashedPassword = await bcrypt.hash(randomPassword, 10);

        // Wrap db.run in a promise
        const insertUser = () =>
          new Promise((resolve, reject) => {
            db.run(
              "INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)",
              [safeName, email, null, hashedPassword],
              function (err2) {
                if (err2) return reject(err2);
                resolve(this.lastID);
              }
            );
          });

        const userId = await insertUser();
        return issueTokenAndRespond(res, req, userId, email, safeName, 0, true);
      } else {
        return issueTokenAndRespond(
          res,
          req,
          row.id,
          row.email,
          row.name || nameFromGoogle,
          Number(row.is_admin) || 0,
          true
        );
      }
    } catch (err) {
      console.error("Google OAuth callback error:", err);
      return res.redirect(`${CLIENT_URL}/login?error=signup_failed`);
    }
  }
);


// ---------- REGISTER & LOGIN ----------
app.post("/api/register", async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password) return res.status(400).json({ message: "All fields are required" });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)`,
      [name, email, phone, hashedPassword],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) return res.status(400).json({ message: "Email already exists" });
          console.error("Register insert error:", err.message);
          return res.status(500).json({ message: err.message });
        }
        return issueTokenAndRespond(res, req, this.lastID, email, name, 0, false);
      }
    );
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  db.get("SELECT * FROM users WHERE email = ?", [email], async (err, row) => {
    if (err) return res.status(500).json({ message: err.message });
    if (!row) return res.status(401).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, row.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid password" });

    return issueTokenAndRespond(res, req, row.id, row.email, row.name, row.is_admin, false);
  });
});

// ---------- Get User Profile ----------
app.get("/api/users/:id", authenticateToken, (req, res) => {
  const requestedId = Number(req.params.id);
  if (requestedId !== Number(req.user.id)) return res.status(403).json({ message: "Access denied" });

  db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [requestedId], (err, row) => {
    if (err) return res.status(500).json({ message: err.message });
    if (!row) return res.status(404).json({ message: "User not found" });
    res.json(row);
  });
});

// ---------- Update User Profile ----------
app.put("/api/users/:id", authenticateToken, (req, res) => {
  const requestedId = Number(req.params.id);
  if (requestedId !== Number(req.user.id)) return res.status(403).json({ message: "Access denied" });

  const { name, email, phone } = req.body;
  if (!name || !email || !phone) return res.status(400).json({ message: "All fields are required" });

  db.run("UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?", [name, email, phone, requestedId], function (err) {
    if (err) return res.status(500).json({ message: err.message });
    if (this.changes === 0) return res.status(404).json({ message: "User not found" });

    db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [requestedId], (err2, row) => {
      if (err2) return res.status(500).json({ message: err2.message });
      res.json(row);
    });
  });
});

// ---------- Mount other feature routes ----------
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/products", productsRouter);
app.use("/api/cart", cartRouter);
app.use("/api/orders", orderRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/user/orders", authenticateToken, userOrdersRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/payments", paymentsRouter);
app.use("/api/account", accountSettingsRoutes);

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
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ message: "API route not found" });
  next();
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

export { app, db };


