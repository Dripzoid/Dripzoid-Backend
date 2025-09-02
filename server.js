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
const JWT_SECRET = process.env.JWT_SECRET || "Dripzoid.App@2025";

const app = express();

// Trust proxy if behind load balancer
if (process.env.TRUST_PROXY === "1" || process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// CORS
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Cloudinary config (optional)
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

// Create tables if missing (idempotent)
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device TEXT,
      ip TEXT,
      last_active TEXT
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS user_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT,
      device TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`
  );
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
};

// JWT middleware — validate token (Authorization header or cookie)
function authenticateToken(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.split(" ")[1];
    if (!token && req.cookies && req.cookies.token) token = req.cookies.token;
    if (!token) return res.status(401).json({ message: "No token provided" });

    jwt.verify(token, JWT_SECRET, (err, payload) => {
      if (err) return res.status(403).json({ message: "Invalid or expired token" });
      req.user = payload; // { id, email, is_admin }
      next();
    });
  } catch (err) {
    console.error("authenticateToken error:", err);
    return res.status(500).json({ message: "Authentication error" });
  }
}

// ----------- Passport (Google OAuth) -----------
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

// ----------- Utility: Issue token & activity ----------
/**
 * issueTokenAndRespond:
 * - creates a user_sessions row (DB-persistent)
 * - logs an entry in user_activity (no session_id)
 * - sets httpOnly cookies for token + sessionId
 * - for isOAuth -> redirect to client /account (frontend should call /api/auth/me to hydrate)
 * - for non-OAuth -> return JSON { message, token, sessionId, user }
 */
function issueTokenAndRespond(req, res, userId, email, name = "", isAdmin = 0, isOAuth = false, activityType = "login") {
  try {
    const normalizedEmail = typeof email === "string" ? email.toLowerCase() : "";
    const token = jwt.sign({ id: userId, email: normalizedEmail, is_admin: isAdmin }, JWT_SECRET, {
      expiresIn: "180d",
    });

    const device = getDevice(req);
    const ip = getIP(req);
    const lastActive = new Date().toISOString();

    // Insert into user_sessions
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

        // Log activity (best-effort)
        db.run(
          "INSERT INTO user_activity (user_id, type, device, ip, created_at) VALUES (?, ?, ?, ?, ?)",
          [userId, activityType, device, ip, lastActive],
          function (actErr) {
            if (actErr) console.warn("Failed to insert user_activity:", actErr.message);
            // continue
          }
        );

        // Set httpOnly cookies for client; token and sessionId
        try {
          res.cookie("token", token, { ...AUTH_COOKIE_OPTIONS, maxAge: TOKEN_MAX_AGE_MS });
          res.cookie("sessionId", String(sessionId), { ...AUTH_COOKIE_OPTIONS, maxAge: TOKEN_MAX_AGE_MS });
        } catch (cookieErr) {
          console.warn("Failed to set auth cookies:", cookieErr);
        }

        // OAuth flow: redirect to client /account (frontend should call /api/auth/me to hydrate)
        if (isOAuth) {
          return res.redirect(new URL("/account", CLIENT_URL).toString());
        }

        // Non-OAuth: return JSON with token, sessionId and user (including phone)
        db.get("SELECT phone FROM users WHERE id = ?", [userId], (err, row) => {
          const phone = row?.phone || null;
          return res.json({
            message: "Success",
            token,
            sessionId,
            user: { id: userId, name, email: normalizedEmail, phone, is_admin: isAdmin },
          });
        });
      }
    );
  } catch (err) {
    console.error("Token issuance failed:", err);
    if (isOAuth) return res.redirect(`${CLIENT_URL}/login?error=token_issue_failed`);
    return res.status(500).json({ message: "Failed to issue token" });
  }
}

// ----------- Auth Routes -----------
// Google OAuth entry
app.get("/api/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

// Google OAuth callback
app.get(
  "/api/auth/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${CLIENT_URL}/login?error=google_auth_failed` }),
  async (req, res) => {
    try {
      const emailRaw = req.user?.email;
      const email = typeof emailRaw === "string" ? emailRaw.toLowerCase() : null;
      const nameFromGoogle = (req.user?.name || "").trim();
      if (!email) return res.status(400).json({ message: "Missing email from Google" });

      // find or create user
      db.get("SELECT * FROM users WHERE lower(email) = ?", [email], async (err, row) => {
        if (err) {
          console.error("DB error on Google callback:", err);
          return res.redirect(`${CLIENT_URL}/login?error=db_error`);
        }

        if (!row) {
          // create
          const safeName = nameFromGoogle || email.split("@")[0];
          const randomPassword = crypto.randomBytes(16).toString("hex");
          const hashedPassword = await bcrypt.hash(randomPassword, 10);

          db.run(
            "INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)",
            [safeName, email, null, hashedPassword],
            function (insertErr) {
              if (insertErr) {
                console.error("Insert user error:", insertErr);
                return res.redirect(`${CLIENT_URL}/login?error=user_create_failed`);
              }
              const newUserId = this.lastID;
              return issueTokenAndRespond(req, res, newUserId, email, safeName, 0, true, "register");
            }
          );
        } else {
          // existing user -> issue token and session
          const userId = row.id;
          const userName = row.name || nameFromGoogle;
          const isAdmin = Number(row.is_admin) || 0;
          return issueTokenAndRespond(req, res, userId, email, userName, isAdmin, true, "login");
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
          if (err.message && err.message.includes("UNIQUE constraint failed")) return res.status(400).json({ message: "Email already exists" });
          console.error("Register insert error:", err.message || err);
          return res.status(500).json({ message: err.message || "Failed to register" });
        }
        return issueTokenAndRespond(req, res, this.lastID, normalizedEmail, name, 0, false, "register");
      }
    );
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// Login
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = typeof email === "string" ? email.toLowerCase() : "";

  db.get("SELECT * FROM users WHERE lower(email) = ?", [normalizedEmail], async (err, row) => {
    if (err) {
      console.error("Login DB error:", err);
      return res.status(500).json({ message: err.message });
    }
    if (!row) return res.status(401).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, row.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid password" });

    return issueTokenAndRespond(req, res, row.id, row.email, row.name, Number(row.is_admin), false, "login");
  });
});

// ----------- /api/auth/me -----------
/**
 * Robust /api/auth/me:
 * - Requires valid JWT (authenticateToken)
 * - If sessionId cookie exists and matches DB -> returns that session
 * - If not present or invalid -> creates a new session row, sets sessionId cookie and returns it
 * - Always returns: { message, user, sessionId }
 */
app.get("/api/auth/me", authenticateToken, (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: "Not authenticated" });

    const cookieSessionId = req.cookies?.sessionId;
    const device = getDevice(req);
    const ip = getIP(req);
    const now = new Date().toISOString();

    const returnUserAndSession = (sessionId) => {
      // update last_active for the session (best-effort)
      db.run("UPDATE user_sessions SET last_active = ? WHERE id = ?", [now, sessionId], (uErr) => {
        if (uErr) console.warn("Failed to update session last_active:", uErr.message);
      });

      db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [userId], (uErr, userRow) => {
        if (uErr) return res.status(500).json({ message: "DB error" });
        if (!userRow) return res.status(404).json({ message: "User not found" });

        // Ensure token cookie exists / refresh it so browser retains it
        try {
          const token = jwt.sign({ id: userRow.id, email: userRow.email, is_admin: userRow.is_admin }, JWT_SECRET, { expiresIn: "180d" });
          res.cookie("token", token, { ...AUTH_COOKIE_OPTIONS, maxAge: TOKEN_MAX_AGE_MS });
        } catch (cookieErr) {
          console.warn("Failed to refresh token cookie:", cookieErr);
        }

        return res.json({
          message: "Session valid",
          user: userRow,
          sessionId,
        });
      });
    };

    if (cookieSessionId) {
      // verify session exists and belongs to user
      db.get("SELECT * FROM user_sessions WHERE id = ? AND user_id = ?", [cookieSessionId, userId], (err, row) => {
        if (err) {
          console.error("/api/auth/me DB error:", err);
          return res.status(500).json({ message: "DB error" });
        }
        if (row) {
          // session valid
          return returnUserAndSession(cookieSessionId);
        } else {
          // sessionId cookie present but not valid -> create a new session and set cookie
          db.run("INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)", [userId, device, ip, now], function (insErr) {
            if (insErr) {
              console.error("Failed to create session in /api/auth/me:", insErr);
              return res.status(500).json({ message: "Failed to create session" });
            }
            const newSessionId = this.lastID;
            try {
              res.cookie("sessionId", String(newSessionId), { ...AUTH_COOKIE_OPTIONS, maxAge: TOKEN_MAX_AGE_MS });
            } catch (cookieErr) {
              console.warn("Failed to set sessionId cookie in /api/auth/me:", cookieErr);
            }
            return returnUserAndSession(newSessionId);
          });
        }
      });
    } else {
      // No session cookie: create new session entry and set cookie
      db.run("INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)", [userId, device, ip, now], function (insErr) {
        if (insErr) {
          console.error("Failed to create session in /api/auth/me:", insErr);
          return res.status(500).json({ message: "Failed to create session" });
        }
        const newSessionId = this.lastID;
        try {
          res.cookie("sessionId", String(newSessionId), { ...AUTH_COOKIE_OPTIONS, maxAge: TOKEN_MAX_AGE_MS });
        } catch (cookieErr) {
          console.warn("Failed to set sessionId cookie in /api/auth/me:", cookieErr);
        }
        return returnUserAndSession(newSessionId);
      });
    }
  } catch (err) {
    console.error("/api/auth/me error:", err);
    return res.status(500).json({ message: "Internal error" });
  }
});

// ----------- User profile endpoints -----------
app.get("/api/users/:id", authenticateToken, (req, res) => {
  const requestedId = Number(req.params.id);
  if (requestedId !== Number(req.user.id)) return res.status(403).json({ message: "Access denied" });
  db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [requestedId], (err, row) => {
    if (err) return res.status(500).json({ message: err.message });
    if (!row) return res.status(404).json({ message: "User not found" });
    res.json(row);
  });
});

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

// Logout — deletes sessions (either all for user or a specific one if provided)
app.post("/api/account/signout-session", authenticateToken, (req, res) => {
  const userId = Number(req.user?.id);
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  const providedSessionId = req.body?.sessionId || req.cookies?.sessionId || null;
  const device = getDevice(req);
  const ip = getIP(req);
  const createdAt = new Date().toISOString();

  // Log logout activity (best-effort)
  db.run(
    "INSERT INTO user_activity (user_id, type, device, ip, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId, "logout", device, ip, createdAt],
    (actErr) => {
      if (actErr) console.warn("Failed to insert logout activity:", actErr.message);

      const stmt = providedSessionId ? "DELETE FROM user_sessions WHERE id = ? AND user_id = ?" : "DELETE FROM user_sessions WHERE user_id = ?";
      const params = providedSessionId ? [providedSessionId, userId] : [userId];

      db.run(stmt, params, function (err) {
        if (err) {
          console.error("Failed to remove session(s):", err);
          return res.status(500).json({ message: "Failed to remove session" });
        }

        // Clear cookies
        res.clearCookie("token", { ...AUTH_COOKIE_OPTIONS });
        res.clearCookie("sessionId", { ...AUTH_COOKIE_OPTIONS });

        return res.json({ success: true, removed: this.changes });
      });
    }
  );
});

// ----------- Mount feature routes -----------
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

// ESM export (keep this since package.json has "type": "module")
export { app, db };
