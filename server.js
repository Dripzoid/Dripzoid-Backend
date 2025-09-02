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

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const API_BASE = process.env.API_BASE || "http://localhost:5000";
const JWT_SECRET = process.env.JWT_SECRET || "Dripzoid.App@2025";

const app = express();

// If running behind a proxy (render/Heroku/Nginx), enable trust proxy.
// You can set TRUST_PROXY=1 in production env.
if (process.env.TRUST_PROXY === "1" || process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// CORS (allow credentials for cookie-based auth)
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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
  try {
    const parser = new UAParser(req.headers["user-agent"]);
    const device = parser.getDevice().model || parser.getOS().name || "Unknown Device";
    const browser = parser.getBrowser().name || "";
    return `${device} ${browser}`.trim();
  } catch (e) {
    return "Unknown Device";
  }
}
function getIP(req) {
  // Prefer X-Forwarded-For, else req.ip (respects trust proxy), else socket address
  const xf = req.headers["x-forwarded-for"];
  if (xf) return xf.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "Unknown IP";
}

// Cookie options for auth cookies
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  secure: process.env.NODE_ENV === "production",
  // maxAge is set dynamically when issuing token to align with token expiry if needed
};

// JWT middleware — supports Authorization header or httpOnly cookie
function authenticateToken(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.split(" ")[1];

    if (!token && req.cookies && req.cookies.token) token = req.cookies.token;

    if (!token) return res.status(401).json({ message: "No token provided" });

    jwt.verify(token, JWT_SECRET, (err, payload) => {
      if (err) return res.status(403).json({ message: "Invalid or expired token" });
      req.user = payload;
      req.token = token;

      // if sessionId cookie present, attach to req for convenience
      if (req.cookies && req.cookies.sessionId) {
        req.sessionId = req.cookies.sessionId;
      }
      next();
    });
  } catch (err) {
    console.error("authenticateToken error:", err);
    return res.status(500).json({ message: "Authentication error" });
  }
}

// ---------- Passport (Google OAuth) ----------
app.use(passport.initialize());
// we do NOT use passport.session() or express-session here to avoid in-memory store.
// We use JWT + cookies for session persistence.

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

// ---------- Utility: issue token, create session, set cookies or return JSON ----------
// Adds insertion into user_sessions and user_activity (activityType: 'login'|'register'|'logout' etc.)
function issueTokenAndRespond(req, res, userId, email, name = "", isAdmin = 0, isOAuth = false, activityType = "login") {
  try {
    const token = jwt.sign({ id: userId, email, is_admin: isAdmin }, JWT_SECRET, {
      expiresIn: "180d",
    });

    const device = getDevice(req);
    const ip = getIP(req);
    const lastActive = new Date().toISOString();

    // Insert user_sessions
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
        const tokenMaxAgeMs = 1000 * 60 * 60 * 24 * 180;
        const activityCreatedAt = new Date().toISOString();

        // Insert a corresponding user_activity row (best-effort; don't fail the response if this errors)
        db.run(
          "INSERT INTO user_activity (user_id, session_id, type, device, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [userId, sessionId, activityType, device, ip, activityCreatedAt],
          function (actErr) {
            if (actErr) {
              // warn but continue
              console.warn("Failed to insert user_activity:", actErr.message);
            }

            // After recording session + activity, respond
            if (isOAuth) {
              // Store token + sessionId in httpOnly cookies (frontend can call /api/auth/me to hydrate)
              try {
                res.cookie("token", token, { ...AUTH_COOKIE_OPTIONS, maxAge: tokenMaxAgeMs });
                res.cookie("sessionId", String(sessionId), { ...AUTH_COOKIE_OPTIONS, maxAge: tokenMaxAgeMs });
              } catch (cookieErr) {
                console.warn("Failed to set auth cookies:", cookieErr);
              }

              // Redirect to client account page WITHOUT leaking token/sessionId in URL
              const redirectUrl = new URL("/account", CLIENT_URL);
              return res.redirect(redirectUrl.toString());
            } else {
              // Normal API login → JSON response
              return res.json({
                message: "Success",
                token,
                sessionId,
                user: { id: userId, name, email, is_admin: isAdmin },
              });
            }
          }
        );
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
  passport.authenticate("google", { session: false, failureRedirect: `${CLIENT_URL}/login?error=google_auth_failed` }),
  async (req, res) => {
    try {
      const email = req.user?.email;
      const nameFromGoogle = (req.user?.name || "").trim();
      if (!email) return res.status(400).json({ message: "Missing email from Google" });

      // Check if user exists or create
      db.get("SELECT * FROM users WHERE email = ?", [email], async (err, row) => {
        if (err) {
          console.error("DB error on Google callback:", err);
          return res.status(500).json({ message: "Database error" });
        }

        if (!row) {
          // create user then issue token with activityType 'register'
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
              // issue token and record activity as 'register'
              return issueTokenAndRespond(req, res, newUserId, email, safeName, 0, true, "register");
            }
          );
        } else {
          // existing user: login, activityType 'login'
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
          if (err.message && err.message.includes("UNIQUE constraint failed")) return res.status(400).json({ message: "Email already exists" });
          console.error("Register insert error:", err.message || err);
          return res.status(500).json({ message: err.message || "Failed to register" });
        }
        // Inserted new user: issue token and record activityType 'register'
        return issueTokenAndRespond(req, res, this.lastID, email, name, 0, false, "register");
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
    if (err) {
      console.error("Login DB error:", err);
      return res.status(500).json({ message: err.message });
    }
    if (!row) return res.status(401).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, row.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid password" });

    // Successful login: record activityType 'login'
    return issueTokenAndRespond(req, res, row.id, row.email, row.name, row.is_admin, false, "login");
  });
});

// ---------- /api/auth/me  - validate token and return user ----------
app.get("/api/auth/me", authenticateToken, (req, res) => {
  const userId = Number(req.user?.id);
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [userId], (err, row) => {
    if (err) {
      console.error("/api/auth/me DB error:", err);
      return res.status(500).json({ message: "Database error" });
    }
    if (!row) return res.status(404).json({ message: "User not found" });

    // Update last_active for this session if sessionId present
    const sessionId = req.sessionId;
    if (sessionId) {
      db.run("UPDATE user_sessions SET last_active = ? WHERE id = ?", [new Date().toISOString(), sessionId], (uErr) => {
        if (uErr) console.warn("Failed to update session last_active:", uErr.message);
      });
    }

    res.json(row);
  });
});

// ---------- Sign out session route ----------
// Records a 'logout' activity (best-effort) then removes session and clears cookies
app.post("/api/account/signout-session", authenticateToken, (req, res) => {
  const sessionId = req.body?.sessionId || req.cookies?.sessionId || req.sessionId;
  const userId = Number(req.user?.id);

  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  const device = getDevice(req);
  const ip = getIP(req);
  const createdAt = new Date().toISOString();

  // Insert logout activity first (best-effort)
  db.run(
    "INSERT INTO user_activity (user_id, session_id, type, device, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [userId, sessionId || null, "logout", device, ip, createdAt],
    function (actErr) {
      if (actErr) console.warn("Failed to insert logout activity:", actErr.message);

      // Now delete session(s)
      const stmt = sessionId
        ? "DELETE FROM user_sessions WHERE id = ? AND user_id = ?"
        : "DELETE FROM user_sessions WHERE user_id = ?";
      const params = sessionId ? [sessionId, userId] : [userId];

      db.run(stmt, params, function (err) {
        if (err) {
          console.error("Failed to remove session:", err);
          return res.status(500).json({ message: "Failed to remove session" });
        }

        // Clear auth cookies (client-side httpOnly cookies)
        res.clearCookie("token", { ...AUTH_COOKIE_OPTIONS });
        res.clearCookie("sessionId", { ...AUTH_COOKIE_OPTIONS });

        return res.json({ success: true, removed: this.changes });
      });
    }
  );
});

// ---------- Get User Profile ----------
app.get("/api/users/:id", authenticateToken, (req, res) => {
  const requestedId = Number(req.params.id);
  if (requestedId !== Number(req.user.id)) return res.status(403).json({ message: "Access denied" });

  db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [requestedId], (err, row) => {
    if (err) {
      console.error("GET /api/users/:id DB error:", err);
      return res.status(500).json({ message: err.message });
    }
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
    if (err) {
      console.error("PUT /api/users/:id DB error:", err);
      return res.status(500).json({ message: err.message });
    }
    if (this.changes === 0) return res.status(404).json({ message: "User not found" });

    db.get("SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?", [requestedId], (err2, row) => {
      if (err2) {
        console.error("GET after update DB error:", err2);
        return res.status(500).json({ message: err2.message });
      }
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

// 404 handler for API paths
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
