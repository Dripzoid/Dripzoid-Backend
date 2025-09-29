// server.js (final — fully corrected)
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import sqlite3 from "sqlite3";
import multer from "multer";
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
import fs from "fs";

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

import shippingRoutes from "./shipping.js"; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const API_BASE = process.env.API_BASE || "http://localhost:5000";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const isProduction = process.env.NODE_ENV === 'production';

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

// -------------------- SQLite async helpers --------------------
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function runGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function runExecute(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}


// -------------------- JWT Middleware --------------------

function authenticateToken(req, res, next) {
  try {
    let token = null;

    // 1. Try Authorization header (for tokens stored in localStorage)
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      token = authHeader.split(" ")[1];
    }

    // 2. Fallback: Try cookie (for tokens stored in cookies)
    if (!token && req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    // 3. Verify token
    jwt.verify(token, JWT_SECRET, (err, payload) => {
      if (err) {
        return res.status(403).json({ message: "Invalid or expired token" });
      }

      // 4. Attach useful values for downstream routes
      req.user = payload;                 // e.g. { id, email, is_admin, sessionId? }
      req.token = token;
      req.sessionId = payload?.sessionId || req.cookies?.sessionId || null;

      next();
    });
  } catch (err) {
    console.error("authenticateToken error:", err);
    return res.status(500).json({ message: "Authentication error" });
  }
}

export default authenticateToken;


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
    // pass the raw profile through so the callback handler can inspect full profile
    (req, accessToken, refreshToken, profile, done) => {
      done(null, profile);
    }
  )
);

// -------------------- OTP Routes --------------------
app.use("/api", otpRoutes);

// -------------------- Token helper --------------------
// issueTokenAndRespond: sets cookies and returns JSON OR redirects (if options.redirect provided)
function issueTokenAndRespond(req, res, userRow, sessionId, message = "Success", options = {}) {
  try {
    const id = Number(userRow.id);
    const email = (userRow.email || "").toLowerCase();
    const is_admin = Number(userRow.is_admin || 0);

    // always include sessionId in JWT so authenticateToken can use it
    const token = jwt.sign({ id, email, is_admin, sessionId }, JWT_SECRET, { expiresIn: "180d" });

    // set cookies (token + sessionId) — frontend will still call /api/auth/me to get user object if needed
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

    if (options && options.redirect) {
      // redirect for OAuth flows (frontend will then hit /api/auth/me via credentials:include to get user+token)
      return res.redirect(options.redirect);
    }

    return res.json({ message, token, sessionId, user: userResp });
  } catch (err) {
    console.error("issueTokenAndRespond error:", err);
    return res.status(500).json({ message: "Failed to issue token" });
  }
}

// createSessionAndRespond: used by OAuth callback — requires req & res
function createSessionAndRespond(req, res, user, actionLabel) {
  const now = new Date().toISOString(); // current timestamp in ISO format

db.run(
  "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
  [row.id, getDevice(req), getIP(req), now],

    function (sessErr) {
      if (sessErr) {
        console.error("Session insert error:", sessErr);
        return res.status(500).json({ error: "session" });
      }

      const sessionId = this.lastID;
      insertUserActivity(user.id, actionLabel, () => {});

      // Use issueTokenAndRespond but redirect back to frontend for OAuth flow
      return issueTokenAndRespond(req, res, user, sessionId, actionLabel, { redirect: `${CLIENT_URL}/account?oauth=1` });
    }
  );
}

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

          const now = new Date().toISOString(); // current timestamp in ISO format

db.run(
  "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
  [row.id, getDevice(req), getIP(req), now],

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

      const now = new Date().toISOString(); // current timestamp in ISO format

db.run(
  "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
  [row.id, getDevice(req), getIP(req), now],
        function (sessErr) {
          if (sessErr) return res.status(500).json({ message: "Failed to create session" });
          const sessionId = this.lastID;
          insertUserActivity(row.id, "Logged In", () => {});
          return issueTokenAndRespond(req, res, row, sessionId, "Login successful");
        }
      );
    });
  } catch (err) {
    console.error("Login error:", err);
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
    console.error("Reset-password error:", err);
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
      // passport returned the raw profile (we configured verify to forward profile)
      const profile = req.user || {};

      // Robust email extraction (works with profile object or simpler objects)
      const email =
        (
          (profile.email && String(profile.email)) ||
          (profile.emails && profile.emails[0] && profile.emails[0].value) ||
          (profile._json && profile._json.email) ||
          ""
        ).toLowerCase().trim();

      const name =
        profile.displayName ||
        (profile.name && `${profile.name.givenName || ""} ${profile.name.familyName || ""}`.trim()) ||
        profile._json?.name ||
        "Google User";

      if (!email) {
        console.error("Google login failed: no email in profile");
        return res.status(400).json({ error: "google_no_email" });
      }

      // Check if user exists
      db.get("SELECT * FROM users WHERE lower(email) = ?", [email], async (err, row) => {
        if (err) {
          console.error("DB lookup error (google callback):", err);
          return res.status(500).json({ error: "server" });
        }

        if (row) {
          // Existing user — create session & redirect
          return createSessionAndRespond(req, res, row, "Logged In (Google)");
        }

        // New user → create one (ensure name saved)
        try {
          const randomPass = crypto.randomBytes(16).toString("hex");
          const hashedPassword = await bcrypt.hash(randomPass, 10);

          db.run(
            "INSERT INTO users (name, email, phone, password, gender, dob, is_admin) VALUES (?, ?, ?, ?, ?, ?, 0)",
            [name || null, email, null, hashedPassword, null, null],
            function (insErr) {
              if (insErr) {
                console.error("DB user insert error:", insErr);
                return res.status(500).json({ error: "create" });
              }

              const createdUserId = this.lastID;
              db.get("SELECT * FROM users WHERE id = ?", [createdUserId], (err2, newUserRow) => {
                if (err2 || !newUserRow) {
                  console.error("DB select after insert error:", err2);
                  return res.status(500).json({ error: "db" });
                }
                return createSessionAndRespond(req, res, newUserRow, "Registered via Google");
              });
            }
          );
        } catch (hashErr) {
          console.error("Hashing error:", hashErr);
          return res.status(500).json({ error: "internal" });
        }
      });
    } catch (err) {
      console.error("Unhandled error in google callback:", err);
      return res.status(500).json({ error: "internal" });
    }
  }
);

/**
 * Get all users (admin only ideally)
 */
app.get("/api/users", async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 7); // 7-day activity window
    const sinceIso = since.toISOString();

    // Fetch all users
    const users = await runQuery(
      `SELECT id, name, email, phone, is_admin, created_at, gender, dob FROM users`
    );

    const activitySources = [
      { table: "wishlist_items", col: "created_at", userField: "user_id" },
      { table: "users", col: "created_at", userField: "id" },
      { table: "user_activity", col: "created_at", userField: "user_id" },
      { table: "orders", col: "created_at", userField: "user_id" },
      { table: "cart_items", col: "added_at", userField: "user_id" },
      { table: "user_sessions", col: "last_active", userField: "user_id" },
      { table: "questions", col: "createdAt", userField: "userId" },
      { table: "answers", col: "createdAt", userField: "userId" },
      { table: "reviews", col: "createdAt", userField: "userId" },
    ];

    const enriched = [];

    for (const u of users) {
      // Check 7-day activity
      let isActive = false;
      for (const { table, col, userField } of activitySources) {
        const row = await runGet(
          `SELECT 1 FROM ${table} WHERE ${userField} = ? AND ${col} >= ? LIMIT 1`,
          [u.id, sinceIso]
        );
        if (row) {
          isActive = true;
          break;
        }
      }

      // Fetch order stats
      const [
        totalOrdersRes,
        successfulOrdersRes,
        cancelledOrdersRes,
        totalSpendRes,
        couponSavingsRes,
        lastActiveRes
      ] = await Promise.all([
        runGet(`SELECT COUNT(*) as count FROM orders WHERE user_id = ?`, [u.id]),
        runGet(
          `SELECT COUNT(*) AS count
           FROM orders
           WHERE user_id = ?
             AND LOWER(status) IN ('delivered')`,
          [u.id]
        ),
        runGet(
          `SELECT COUNT(*) AS count
           FROM orders
           WHERE user_id = ?
             AND LOWER(status) IN ('cancelled', 'returned')`,
          [u.id]
        ),
        runGet(`SELECT SUM(total_amount) as total FROM orders WHERE user_id = ?`, [u.id]),
       runGet(`
  SELECT 
    SUM(
      oi_sum.order_items_sum - o.total_amount + 
      CASE WHEN LOWER(o.payment_method) = 'cod' THEN 25 ELSE 0 END
    ) AS savings
  FROM orders o
  JOIN (
      SELECT order_id, SUM(price) AS order_items_sum
      FROM order_items
      GROUP BY order_id
  ) oi_sum ON o.id = oi_sum.order_id
  WHERE o.user_id = ?
`, [u.id]),
        // Fetch last_active from user_sessions (latest timestamp)
        runGet(`SELECT MAX(last_active) AS last_active FROM user_sessions WHERE user_id = ?`, [u.id])
      ]);

      const totalOrders = totalOrdersRes?.count ?? 0;
      const successfulOrders = successfulOrdersRes?.count ?? 0;
      const cancelledOrders = cancelledOrdersRes?.count ?? 0;
      const inProgressOrders = totalOrders - (successfulOrders + cancelledOrders);

      enriched.push({
        ...u,
        role: u.is_admin === 1 ? "admin" : "customer",
        status: isActive ? "active" : "inactive",
        totalOrders,
        successfulOrders,
        cancelledOrders,
        inProgressOrders,
        totalSpend: totalSpendRes?.total ?? 0,
        couponSavings: couponSavingsRes?.savings ?? 0,
        last_active: lastActiveRes?.last_active || null, // added field
      });
    }

    res.json(enriched);
  } catch (err) {
    console.error("Fetch users error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});



/**
 * Get single user by ID
 */
app.get("/api/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    // Fetch user basic info
    const users = await runQuery(
      `SELECT id, name, email, phone, is_admin, created_at, gender, dob
       FROM users WHERE id = ?`,
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ error: "User not found" });

    const user = users[0];

    // Aggregate stats
    const [
      totalOrdersRes,
      successfulOrdersRes,
      cancelledOrdersRes,
      inProgressOrdersRes,
      totalSpendRes,
      couponSavingsRes
    ] = await Promise.all([
      runGet(`SELECT COUNT(*) as count FROM orders WHERE user_id = ?`, [userId]),
     // Count Delivered orders (case-insensitive)
runGet(
  `SELECT COUNT(*) AS count
   FROM orders
   WHERE user_id = ?
     AND LOWER(status) IN ('delivered')`,
  [userId]
),

// Count Cancelled/Returned orders (case-insensitive)
runGet(
  `SELECT COUNT(*) AS count
   FROM orders
   WHERE user_id = ?
     AND LOWER(status) IN ('cancelled', 'returned')`,
  [userId]
),


      runGet(`SELECT SUM(total_amount) as total FROM orders WHERE user_id = ?`, [userId]),
      runGet(`
        SELECT 
          SUM(o.total_amount) - SUM(oi.price) as savings
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        WHERE o.user_id = ?`,
        [userId]
      )
    ]);
  const inProgressOrders = totalOrders - (successfulOrders + cancelledOrders);
    const enrichedUser = {
      ...user,
      role: user.is_admin === 1 ? "admin" : "customer",
      totalOrders: totalOrdersRes?.count ?? 0,
      successfulOrders: successfulOrdersRes?.count ?? 0,
      cancelledOrders: cancelledOrdersRes?.count ?? 0,
      inProgressOrders: inProgressOrdersRes?.count ?? 0,
      totalSpend: totalSpendRes?.total ?? 0,
      couponSavings: couponSavingsRes?.savings ?? 0,
    };

    res.json(enrichedUser);
  } catch (err) {
    console.error("Fetch user error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});


/**
 * Update user (role, status, etc.)
 */
app.put("/api/users/:id", async (req, res) => {
  try {
    const { name, phone, gender, dob, is_admin } = req.body;

    await runExecute(
      `UPDATE users SET name = ?, phone = ?, gender = ?, dob = ?, is_admin = ? WHERE id = ?`,
      [name, phone, gender, dob, is_admin, req.params.id]
    );

    res.json({ message: "User updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update user" });
  }
});

/**
 * Delete user
 */
app.delete("/api/users/:id", async (req, res) => {
  try {
    await runExecute(`DELETE FROM users WHERE id = ?`, [req.params.id]);
    res.json({ message: "User deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// -------------------- Signout and session management --------------------

// Changed route: /api/signout-session (was /api/logout)
app.post("/api/account/signout-session", authenticateToken, (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const sessionId = req.sessionId; // ✅ from token payload OR cookie (set in authenticateToken)

    if (!userId) {
      return res.status(400).json({ message: "Invalid user" });
    }

    const finishSignout = () => {
      try {
        // clear cookies (even if frontend uses localStorage, harmless to clear)
        res.clearCookie("token", AUTH_COOKIE_OPTIONS);
        res.clearCookie("sessionId", AUTH_COOKIE_OPTIONS);
      } catch (e) {
        /* ignore cookie clear errors */
      }

      // ✅ Log user activity
      insertUserActivity(userId, "Logged Out", () => {});

      return res.json({ message: "Signed out" });
    };

    if (sessionId) {
      // Delete specific session
      db.run(
        "DELETE FROM user_sessions WHERE id = ? AND user_id = ?",
        [sessionId, userId],
        function (err) {
          if (err) {
            console.error("Signout delete session error:", err);
          }
          finishSignout();
        }
      );
    } else {
      // fallback: delete latest session for user
      db.get(
        "SELECT id FROM user_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
        [userId],
        (selErr, selRow) => {
          if (selErr) {
            console.error("Signout fallback select error:", selErr);
          }
          const delId = selRow?.id ?? null;
          if (delId) {
            db.run(
              "DELETE FROM user_sessions WHERE id = ? AND user_id = ?",
              [delId, userId],
              function (err) {
                if (err) {
                  console.error("Signout delete fallback session error:", err);
                }
                finishSignout();
              }
            );
          } else {
            finishSignout();
          }
        }
      );
    }
  } catch (err) {
    console.error("Signout error:", err);
    return res.status(500).json({ message: "Signout failed" });
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

// -------------------- Current User --------------------
app.get("/api/auth/me", authenticateToken, (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: "Not authenticated" });

    db.get(
      "SELECT id, name, email, phone, gender, dob, is_admin, created_at FROM users WHERE id = ?",
      [userId],
      (err, row) => {
        if (err) {
          console.error("GET /api/auth/me DB error:", err);
          return res.status(500).json({ message: "Failed to fetch user" });
        }
        if (!row) return res.status(404).json({ message: "User not found" });

        return res.json({
          user: row,
          token: req.token || null,
          sessionId: req.sessionId || null,
        });
      }
    );
  } catch (err) {
    console.error("GET /api/auth/me error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});
// -------------------- Data Export --------------------
app.get("/api/admin/data-export", auth, (req, res) => {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return res.status(404).json({ message: "Database file not found" });
    }

    // Create a filename with today's date
    const fileName = `dripzoid-backup-${new Date().toISOString().split("T")[0]}.db`;

    // Set headers to trigger file download
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    // Stream the DB file to the client
    const fileStream = fs.createReadStream(DB_PATH);
    fileStream.pipe(res);

    // Handle any stream errors
    fileStream.on("error", (err) => {
      console.error("File streaming error:", err);
      if (!res.headersSent) res.status(500).json({ message: "Failed to export database" });
    });
  } catch (err) {
    console.error("Data export error:", err);
    if (!res.headersSent) res.status(500).json({ message: "Failed to export database" });
  }
});


// --- DB upload route ---
const upload = multer({ dest: "/tmp/" });
app.post("/api/upload-db", upload.single("dbfile"), (req,res)=>{
  try{
    const tokenUpload = req.headers["X-Upload-Token"];
    if(!tokenUpload || tokenUpload!==UPLOAD_SECRET) return res.status(403).json({message:"Unauthorized"});
    if(!req.file) return res.status(400).json({message:"No file uploaded"});
    const tempPath = req.file.path;
    if(path.extname(req.file.originalname)!==".db"){ fs.unlinkSync(tempPath); return res.status(400).json({message:"Only .db allowed"}); }
    if(fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_PATH+".backup");
    fs.renameSync(tempPath, DB_PATH);
    return res.json({message:"DB replaced successfully"});
  }catch(err){ console.error(err); res.status(500).json({message:"Failed to replace DB"}); }
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
app.use("/api/shipping", shippingRoutes);

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
































