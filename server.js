// server.js (final — fully corrected)
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

import otpRoutes from "./OtpVerification.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const API_BASE = process.env.API_BASE || "http://localhost:5000";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

const app = express();

// -------------------- Middleware & CORS --------------------
if (process.env.TRUST_PROXY === "1" || process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
    exposedHeaders: ["Content-Length"],
  })
);

app.options("*", cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// -------------------- Request Logger --------------------
app.use((req, res, next) => {
  const start = Date.now();
  const ip = req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress;
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} - ${ms}ms - ${ip}`);
  });
  next();
});

// -------------------- SQLite DB init --------------------
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
      gender TEXT,
      dob TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      otp_hash TEXT,
      otp_created_at INTEGER,
      verified INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device TEXT,
      ip TEXT,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
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

const TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // 180 days
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: TOKEN_MAX_AGE_MS,
};

// Insert user_activity with dedupe
function insertUserActivity(userId, action, cb) {
  const dedupeSeconds = 3;
  db.get(
    "SELECT id, created_at FROM user_activity WHERE user_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
    [userId, action],
    (err, row) => {
      if (err) return cb && cb(err);
      if (!row) {
        return db.run(
          "INSERT INTO user_activity (user_id, action) VALUES (?, ?)",
          [userId, action],
          function (insErr) {
            if (insErr) return cb && cb(insErr);
            return cb && cb(null, this.lastID);
          }
        );
      }
      db.get("SELECT (strftime('%s','now') - strftime('%s', ?)) AS diff", [row.created_at], (diffErr, diffRow) => {
        if (diffErr) return cb && cb(diffErr);
        const diff = Number(diffRow?.diff ?? 999999);
        if (diff <= dedupeSeconds) return cb && cb(null, null);
        db.run("INSERT INTO user_activity (user_id, action) VALUES (?, ?)", [userId, action], function (insErr) {
          if (insErr) return cb && cb(insErr);
          return cb && cb(null, this.lastID);
        });
      });
    }
  );
}

// -------------------- JWT Middleware --------------------
function authenticateToken(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers["authorization"];
    if (authHeader?.toLowerCase().startsWith("bearer ")) token = authHeader.split(" ")[1];
    if (!token && req.cookies?.token) token = req.cookies.token;
    if (!token) return res.status(401).json({ message: "No token provided" });

    jwt.verify(token, JWT_SECRET, (err, payload) => {
      if (err) return res.status(403).json({ message: "Invalid or expired token" });
      req.user = payload;
      next();
    });
  } catch (err) {
    return res.status(500).json({ message: "Authentication error" });
  }
}

// -------------------- Passport Google OAuth --------------------
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
      done(null, user);
    }
  )
);

// -------------------- OTP Routes --------------------
app.use("/api", otpRoutes);

// -------------------- Token helper --------------------
function issueTokenAndRespond(req, res, userRow, sessionId, message = "Success") {
  try {
    const id = Number(userRow.id);
    const email = (userRow.email || "").toLowerCase();
    const is_admin = Number(userRow.is_admin || 0);

    const token = jwt.sign({ id, email, is_admin }, JWT_SECRET, { expiresIn: "180d" });

    try {
      res.cookie("token", token, AUTH_COOKIE_OPTIONS);
      res.cookie("sessionId", String(sessionId), AUTH_COOKIE_OPTIONS);
    } catch (cookieErr) {
      console.warn("issueTokenAndRespond: failed to set cookies:", cookieErr);
    }

    const userResp = {
      id,
      name: userRow.name || null,
      email,
      phone: userRow.phone || null,
      gender: userRow.gender || null,
      dob: userRow.dob || null,
      is_admin,
    };
    if (userRow.created_at) userResp.created_at = userRow.created_at;

    return res.json({ message, token, sessionId, user: userResp });
  } catch (err) {
    console.error("issueTokenAndRespond error:", err);
    return res.status(500).json({ message: "Failed to issue token" });
  }
}

const createSessionAndRespond = (user, actionLabel) => {
  db.run(
    "INSERT INTO user_sessions (user_id, device, ip) VALUES (?, ?, ?)",
    [user.id, getDevice(req), getIP(req)],
    function (sessErr) {
      if (sessErr) return res.status(500).json({ error: "session" });
      const sessionId = this.lastID;

      insertUserActivity(user.id, actionLabel, () => {});

      const token = jwt.sign(
        { id: Number(user.id), email: user.email, is_admin: Number(user.is_admin || 0) },
        JWT_SECRET,
        { expiresIn: "180d" }
      );

      return res.json({
        token,
        sessionId,
        user,
      });
    }
  );
};


// -------------------- Auth --------------------

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, phone, mobile, password, gender, dob } = req.body;
    const phoneVal = phone || mobile || "";
    if (!name || !email || !password) return res.status(400).json({ message: "Name, email and password required" });

    const normalizedEmail = (email || "").toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);

    db.run(
      "INSERT INTO users (name, email, phone, password, gender, dob, is_admin) VALUES (?, ?, ?, ?, ?, ?, 0)",
      [name, normalizedEmail, phoneVal, hashedPassword, gender || null, dob || null],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) return res.status(409).json({ message: "Email already exists" });
          console.error("Register insert error:", err);
          return res.status(500).json({ message: "Failed to register" });
        }

        const createdUserId = this.lastID;
        db.get("SELECT * FROM users WHERE id = ?", [createdUserId], (err2, userRow) => {
          if (err2 || !userRow) return res.status(500).json({ message: "DB error" });

          db.run(
            "INSERT INTO user_sessions (user_id, device, ip) VALUES (?, ?, ?)",
            [userRow.id, getDevice(req), getIP(req)],
            function (sessErr) {
              if (sessErr) return res.status(500).json({ message: "Failed to create session" });
              const sessionId = this.lastID;
              insertUserActivity(userRow.id, "Registered & Logged In", () => {});
              return issueTokenAndRespond(req, res, userRow, sessionId, "User registered successfully");
            }
          );
        });
      }
    );
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ message: err.message || "Internal error" });
  }
});

// Login
app.post("/api/login", (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const normalizedEmail = email.toLowerCase();
    db.get("SELECT * FROM users WHERE lower(email) = ?", [normalizedEmail], async (err, row) => {
      if (err) return res.status(500).json({ message: "DB error" });
      if (!row) return res.status(404).json({ message: "User not found" });

      const isMatch = await bcrypt.compare(password, row.password);
      if (!isMatch) return res.status(401).json({ message: "Invalid password" });

      db.run(
        "INSERT INTO user_sessions (user_id, device, ip) VALUES (?, ?, ?)",
        [row.id, getDevice(req), getIP(req)],
        function (sessErr) {
          if (sessErr) return res.status(500).json({ message: "Failed to create session" });
          const sessionId = this.lastID;
          insertUserActivity(row.id, "Logged In", () => {});
          return issueTokenAndRespond(req, res, row, sessionId, "Login successful");
        }
      );
    });
  } catch (err) {
    return res.status(500).json({ message: "Internal error" });
  }
});

// -------------------- Password reset endpoints --------------------
app.post("/api/reset-password", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and new password required" });

    const normalizedEmail = String(email).toLowerCase();
    db.get("SELECT * FROM users WHERE lower(email) = ?", [normalizedEmail], async (err, row) => {
      if (err) return res.status(500).json({ message: "DB error" });
      if (!row) return res.status(404).json({ message: "User not found" });

      const newHashed = await bcrypt.hash(password, 10);
      db.run("UPDATE users SET password = ? WHERE id = ?", [newHashed, row.id], function (updErr) {
        if (updErr) return res.status(500).json({ message: "Failed to update password" });
        insertUserActivity(row.id, "Password Reset", () => {});
        return res.json({ message: "Password updated" });
      });
    });
  } catch (err) {
    return res.status(500).json({ message: "Internal error" });
  }
});


// -------------------- Google OAuth --------------------

// Initiate Google OAuth
app.get("/api/auth/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));

// Callback
app.get(
  "/api/auth/google/callback",
  passport.authenticate("google", { failureRedirect: `${CLIENT_URL}/login`, session: false }),
  async (req, res) => {
    try {
      const profile = req.user || {};
      const email = (profile.email || "").toLowerCase();
      const name = profile.name || "";
      if (!email) return res.status(400).json({ error: "google_no_email" });

      db.get("SELECT * FROM users WHERE lower(email) = ?", [email], async (err, row) => {
        if (err) return res.status(500).json({ error: "server" });

        const createSessionAndRespond = (user, actionLabel) => {
          db.run(
            "INSERT INTO user_sessions (user_id, device, ip) VALUES (?, ?, ?)",
            [user.id, getDevice(req), getIP(req)],
            function (sessErr) {
              if (sessErr) return res.status(500).json({ error: "session" });
              const sessionId = this.lastID;
              insertUserActivity(user.id, actionLabel, () => {});

              // JWT (optional, can also skip and use only session cookie)
              const token = jwt.sign(
                { id: Number(user.id), email: user.email, is_admin: Number(user.is_admin || 0) },
                JWT_SECRET,
                { expiresIn: "180d" }
              );

              // Set HTTP-only cookie
              res.cookie("session_id", sessionId, {
                httpOnly: true,
                secure: true,      // true if using HTTPS
                sameSite: "none",  // cross-site if client/frontend domain differs
                maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days
              });

              // Redirect to frontend
              return res.redirect(`${CLIENT_URL}/login?oauth=1`);
            }
          );
        };

        if (row) {
          return createSessionAndRespond(row, "Logged In (Google)");
        }

        // New user → register
        const randomPass = crypto.randomBytes(16).toString("hex");
        const hashedPassword = await bcrypt.hash(randomPass, 10);
        db.run(
          "INSERT INTO users (name, email, phone, password, gender, dob, is_admin) VALUES (?, ?, ?, ?, ?, ?, 0)",
          [name || null, email, null, hashedPassword, null, null],
          function (insErr) {
            if (insErr) return res.status(500).json({ error: "create" });
            const createdUserId = this.lastID;
            db.get("SELECT * FROM users WHERE id = ?", [createdUserId], (err2, newUserRow) => {
              if (err2 || !newUserRow) return res.status(500).json({ error: "db" });
              return createSessionAndRespond(newUserRow, "Registered via Google");
            });
          }
        );
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "internal" });
    }
  }
);


// -------------------- Signout and session management --------------------

// Logout current session (uses sessionId cookie or token)
app.post("/api/logout", authenticateToken, (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const cookieSessionId = req.cookies?.sessionId;
    if (!userId) return res.status(400).json({ message: "Invalid user" });

    if (cookieSessionId) {
      db.run("DELETE FROM user_sessions WHERE id = ? AND user_id = ?", [cookieSessionId, userId], function (err) {
        if (err) console.error("Logout delete session error:", err);
        // clear cookies regardless
        try {
          res.clearCookie("token", AUTH_COOKIE_OPTIONS);
          res.clearCookie("sessionId", AUTH_COOKIE_OPTIONS);
        } catch (e) {
          /* ignore cookie clear errors */
        }
        return res.json({ message: "Logged out" });
      });
    } else {
      // fallback: delete any one session for user (best-effort)
      db.run("DELETE FROM user_sessions WHERE user_id = ? LIMIT 1", [userId], function (err) {
        if (err) console.error("Logout delete fallback session error:", err);
        try {
          res.clearCookie("token", AUTH_COOKIE_OPTIONS);
          res.clearCookie("sessionId", AUTH_COOKIE_OPTIONS);
        } catch (e) {}
        return res.json({ message: "Logged out" });
      });
    }
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ message: "Logout failed" });
  }
});

// Logout all sessions for current user
app.post("/api/logout-all", authenticateToken, (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(400).json({ message: "Invalid user" });
    db.run("DELETE FROM user_sessions WHERE user_id = ?", [userId], function (err) {
      if (err) {
        console.error("Logout all error:", err);
        return res.status(500).json({ message: "Failed to logout all" });
      }
      try {
        res.clearCookie("token", AUTH_COOKIE_OPTIONS);
        res.clearCookie("sessionId", AUTH_COOKIE_OPTIONS);
      } catch (e) {}
      return res.json({ message: "All sessions cleared" });
    });
  } catch (err) {
    console.error("Logout-all error:", err);
    return res.status(500).json({ message: "Internal error" });
  }
});

// Get list of sessions for current user
app.get("/api/sessions", authenticateToken, (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(400).json({ message: "Invalid user" });
    db.all("SELECT id, device, ip, last_active FROM user_sessions WHERE user_id = ? ORDER BY id DESC", [userId], (err, rows) => {
      if (err) {
        console.error("Get sessions error:", err);
        return res.status(500).json({ message: "Failed to fetch sessions" });
      }
      return res.json({ sessions: rows || [] });
    });
  } catch (err) {
    console.error("Sessions error:", err);
    return res.status(500).json({ message: "Internal error" });
  }
});

// Revoke a single session (by session id)
app.delete("/api/sessions/:id", authenticateToken, (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const sessionId = Number(req.params.id);
    if (!userId || !sessionId) return res.status(400).json({ message: "Invalid request" });
    db.run("DELETE FROM user_sessions WHERE id = ? AND user_id = ?", [sessionId, userId], function (err) {
      if (err) {
        console.error("Delete session error:", err);
        return res.status(500).json({ message: "Failed to delete session" });
      }
      return res.json({ message: "Session revoked" });
    });
  } catch (err) {
    console.error("Delete session exception:", err);
    return res.status(500).json({ message: "Internal error" });
  }
});

// -------------------- Mount Other Routes --------------------
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

// -------------------- Root + Health --------------------
app.get("/", (req, res) => res.send(`<h2>Dripzoid Backend</h2><p>API available. Use /api routes.</p>`));
app.get("/test-env", (req, res) =>
  res.json({
    nodeEnv: process.env.NODE_ENV || "development",
    clientUrl: CLIENT_URL,
    apiBase: API_BASE,
    jwtConfigured: !!process.env.JWT_SECRET,
    dbPath: DB_PATH,
  })
);

// -------------------- Error & 404 Handlers --------------------
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    console.warn("404 API route:", req.method, req.originalUrl);
    return res.status(404).json({ message: "API route not found" });
  }
  res.status(404).send("Not Found");
});
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
});

// -------------------- Crash protection --------------------
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (reason) => console.error("UNHANDLED REJECTION:", reason));

// -------------------- Start Server --------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} (NODE_ENV=${process.env.NODE_ENV || "development"})`));

export { app, db };







