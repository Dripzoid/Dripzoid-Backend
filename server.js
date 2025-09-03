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
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { UAParser } from "ua-parser-js";
import cookieParser from "cookie-parser";

// Import feature routers (adjust paths if needed)
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

// -------------------- Basic middleware & CORS --------------------
if (process.env.TRUST_PROXY === "1" || process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
    exposedHeaders: ["Content-Length", "X-Kuma-Revision"],
  })
);

// preflight
app.options("*", cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// -------------------- Basic request logger --------------------
app.use((req, res, next) => {
  const start = Date.now();
  const ip = req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress;
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} - ${ms}ms - ${ip}`);
  });
  next();
});

// -------------------- DB init --------------------
const DB_PATH = process.env.DATABASE_FILE || path.join(__dirname, "./dripzoid.db");
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ SQLite connection error:", err.message);
  else console.log("✅ Connected to SQLite database at", DB_PATH);
});
app.locals.db = db;

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

// -------------------- Helpers --------------------
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

const TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180;
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: TOKEN_MAX_AGE_MS,
};

// -------------------- JWT middleware --------------------
function authenticateToken(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers["authorization"];
    if (authHeader && typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
      token = authHeader.split(" ")[1];
    }
    // fallback to cookie token (if server issued httpOnly cookie)
    if (!token && req.cookies?.token) token = req.cookies.token;

    if (!token) {
      console.warn("authenticateToken: no token provided for", req.method, req.originalUrl);
      return res.status(401).json({ message: "No token provided" });
    }

    jwt.verify(token, JWT_SECRET, (err, payload) => {
      if (err) {
        console.warn("authenticateToken: token verify failed", err?.message);
        return res.status(403).json({ message: "Invalid or expired token" });
      }
      req.user = payload;
      next();
    });
  } catch (err) {
    console.error("authenticateToken error:", err);
    return res.status(500).json({ message: "Authentication error" });
  }
}

// -------------------- Passport (Google OAuth) --------------------
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

// -------------------- Token issuance utility --------------------
/**
 * issueTokenAndRespond:
 *  - Creates a user_sessions row
 *  - Inserts a user_activity row (best-effort)
 *  - If isOAuth === true: sets httpOnly cookies for token & sessionId and redirects to CLIENT_URL/account
 *  - Else: responds with JSON { user, token, sessionId }
 */
function issueTokenAndRespond(req, res, userRow, { isOAuth = false, activityType = "login" } = {}) {
  try {
    const id = Number(userRow.id);
    const email = (userRow.email || "").toLowerCase();
    const name = userRow.name || "";
    const is_admin = Number(userRow.is_admin || 0);

    const token = jwt.sign({ id, email, is_admin }, JWT_SECRET, { expiresIn: "180d" });

    const device = getDevice(req);
    const ip = getIP(req);
    const now = new Date().toISOString();

    db.run(
      "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
      [id, device, ip, now],
      function (err2) {
        if (err2) {
          console.error("issueTokenAndRespond: failed to create session:", err2.message);
          if (isOAuth) return res.redirect(`${CLIENT_URL}/login?error=session_create_failed`);
          return res.status(500).json({ message: "Failed to create session" });
        }

        const sessionId = this.lastID;

        // log activity (best-effort)
        db.run(
          "INSERT INTO user_activity (user_id, type, device, ip, created_at) VALUES (?, ?, ?, ?, ?)",
          [id, activityType, device, ip, now],
          (actErr) => {
            if (actErr) console.warn("issueTokenAndRespond: failed to insert user_activity:", actErr.message);
            // continue
          }
        );

        if (isOAuth) {
          // Set httpOnly cookies so client is authenticated without exposing token in URL
          try {
            res.cookie("token", token, AUTH_COOKIE_OPTIONS);
            res.cookie("sessionId", String(sessionId), AUTH_COOKIE_OPTIONS);
          } catch (cookieErr) {
            console.warn("issueTokenAndRespond: failed to set cookies:", cookieErr);
          }

          // Redirect to client account page
          return res.redirect(`${CLIENT_URL}/account`);
        }

        // Non-OAuth: return JSON (frontend may store token in localStorage)
        return res.json({
          message: "Success",
          user: { id, name, email, is_admin },
          token,
          sessionId,
        });
      }
    );
  } catch (err) {
    console.error("issueTokenAndRespond error:", err);
    if (isOAuth) return res.redirect(`${CLIENT_URL}/login?error=token_issue_failed`);
    return res.status(500).json({ message: "Failed to issue token" });
  }
}

// -------------------- Auth routes --------------------

// Google OAuth entry
app.get("/api/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

// Google OAuth callback: we create or find user and then call issueTokenAndRespond with isOAuth=true
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

              // ✅ Issue token for newly created user
              db.get("SELECT * FROM users WHERE id = ?", [this.lastID], (err2, userRow) => {
                if (err2 || !userRow) return res.redirect(`${CLIENT_URL}/login?error=db_fetch_failed`);
                return issueToken(req, res, { ...userRow, is_admin: Number(userRow.is_admin) });
              });
            }
          );
        } else {
          // ✅ Issue token for existing user
          return issueToken(req, res, { ...row, is_admin: Number(row.is_admin) });
        }
      });
    } catch (err) {
      console.error("Google callback error:", err);
      return res.redirect(`${CLIENT_URL}/login?error=oauth_failed`);
    }
  }
);


// Register (API flow) -> returns JSON with token/sessionId
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) return res.status(400).json({ message: "All fields are required" });

    const normalizedEmail = email.toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);

    db.run(
      "INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)",
      [name, normalizedEmail, phone, hashedPassword],
      function (err) {
        if (err) {
          console.error("Register insert error:", err.message || err);
          if (err.message && err.message.includes("UNIQUE constraint failed")) return res.status(409).json({ message: "Email already exists" });
          return res.status(500).json({ message: err.message || "Failed to register" });
        }

        db.get("SELECT * FROM users WHERE id = ?", [this.lastID], (err2, userRow) => {
          if (err2 || !userRow) {
            console.error("Register: unable to fetch created user", err2);
            return res.status(500).json({ message: "DB error" });
          }
          userRow.is_admin = Number(userRow.is_admin || 0);
          return issueTokenAndRespond(req, res, userRow, { isOAuth: false, activityType: "register" });
        });
      }
    );
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ message: error.message || "Failed" });
  }
});

// Login (API flow)
app.post("/api/login", (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const normalizedEmail = email.toLowerCase();
    db.get("SELECT * FROM users WHERE lower(email) = ?", [normalizedEmail], async (err, row) => {
      if (err) {
        console.error("Login DB error:", err);
        return res.status(500).json({ message: err.message });
      }
      if (!row) return res.status(404).json({ message: "User not found" });

      const isMatch = await bcrypt.compare(password, row.password);
      if (!isMatch) return res.status(401).json({ message: "Invalid password" });

      row.is_admin = Number(row.is_admin || 0);
      return issueTokenAndRespond(req, res, row, { isOAuth: false, activityType: "login" });
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "Internal error" });
  }
});

// /api/auth/me - allow cookie-based or Authorization header token
app.get("/api/auth/me", authenticateToken, (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: "Not authenticated" });

    const now = new Date().toISOString();
    db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [userId], (err, userRow) => {
      if (err || !userRow) {
        console.error("/api/auth/me DB error:", err);
        return res.status(500).json({ message: "DB error or user not found" });
      }

      // Refresh cookie token if token was provided via cookie (i.e. cookie flow)
      try {
        const token = jwt.sign({ id: userRow.id, email: userRow.email, is_admin: userRow.is_admin }, JWT_SECRET, { expiresIn: "180d" });
        res.cookie("token", token, AUTH_COOKIE_OPTIONS);
      } catch (cookieErr) {
        console.warn("/api/auth/me: failed to set token cookie:", cookieErr);
      }

      // Create or update session record and return sessionId (best-effort)
      const device = getDevice(req);
      const ip = getIP(req);
      db.run("INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)", [userId, device, ip, now], function (insErr) {
        if (insErr) {
          console.warn("/api/auth/me: failed to insert session:", insErr.message);
          return res.json({ user: userRow, sessionId: null });
        }
        const sessionId = this.lastID;
        // optionally set sessionId cookie for cookie flow
        try {
          res.cookie("sessionId", String(sessionId), AUTH_COOKIE_OPTIONS);
        } catch (cookieErr) {
          console.warn("/api/auth/me: failed to set sessionId cookie:", cookieErr);
        }
        return res.json({ user: userRow, sessionId });
      });
    });
  } catch (err) {
    console.error("/api/auth/me error:", err);
    return res.status(500).json({ message: "Internal error" });
  }
});

// -------------------- Root + health routes --------------------
app.get("/", (req, res) => {
  res.send(`<h2>Dripzoid Backend</h2><p>API available. Try <a href="/test-env">/test-env</a> or use /api routes.</p>`);
});

app.get("/test-env", (req, res) => {
  res.json({
    nodeEnv: process.env.NODE_ENV || "development",
    clientUrl: CLIENT_URL,
    apiBase: API_BASE,
    jwtConfigured: !!process.env.JWT_SECRET,
    dbPath: DB_PATH,
  });
});

// -------------------- Mount other routes --------------------
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

// 404 handler for API
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    console.warn("404 API route:", req.method, req.originalUrl);
    return res.status(404).json({ message: "API route not found" });
  }
  res.status(404).send("Not Found");
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
});

// Crash protection logging
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} (NODE_ENV=${process.env.NODE_ENV || "development"})`));

export { app, db };


