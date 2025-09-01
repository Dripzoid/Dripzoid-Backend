// backend/server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import { v2 as cloudinary } from "cloudinary";
import session from "express-session";              // 🔹 GOOGLE OAUTH
import passport from "passport";                   // 🔹 GOOGLE OAUTH
import { Strategy as GoogleStrategy } from "passport-google-oauth20"; // 🔹 GOOGLE OAUTH
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

const app = express();
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || "Dripzoid.App@2025";

// ✅ Cloudinary Configuration
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// ✅ SQLite connection
const dbPath = path.join(__dirname, "dripzoid.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ SQLite connection error:", err.message);
  else console.log("✅ Connected to SQLite database at", dbPath);
});
app.locals.db = db;

// JWT Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Invalid or missing token" });
  }
  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid or expired token" });
    req.user = user;
    next();
  });
}

// Helpers
function getDevice(req) {
  const parser = new UAParser(req.headers["user-agent"]);
  const device = parser.getDevice().model || parser.getOS().name || "Unknown Device";
  const browser = parser.getBrowser().name || "";
  return `${device} ${browser}`.trim();
}
function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress || "Unknown IP";
}

// =================================================
// 🔹 GOOGLE OAUTH SETUP
// =================================================
// --- Sessions (dev-safe defaults; adjust for prod as needed) ---
app.use(
  session({
    secret: process.env.SESSION_SECRET || "google-oauth-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

// --- Google OAuth Strategy ---
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,          // required
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,  // required
      callbackURL: `${process.env.API_BASE || "http://localhost:5000"}/api/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => {
      // Normalize Google profile
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

// --- Google Auth Routes ---
app.get("/api/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/api/auth/google/callback",
  passport.authenticate("google", {
    // On failure, send to frontend /login with an error code
    failureRedirect: `${process.env.CLIENT_URL}/login?error=google_auth_failed`,
  }),
  (req, res) => {
    // Safety: require email from Google
    const email = req.user?.email;
    const nameFromGoogle = (req.user?.name || "").trim();

    if (!email) {
      return res.redirect(`${process.env.CLIENT_URL}/login?error=missing_email`);
    }

    // Check if user exists
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
      if (err) {
        return res.redirect(`${process.env.CLIENT_URL}/login?error=db_error`);
      }

      if (!row) {
        // New Google user — insert minimal record
        const safeName =
          nameFromGoogle ||
          (typeof email === "string" ? email.split("@")[0] : "User");

        db.run(
          "INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)",
          [safeName, email, null, null],
          function (err2) {
            if (err2) {
              // Likely unique constraint or schema issue
              return res.redirect(`${process.env.CLIENT_URL}/login?error=signup_failed`);
            }
            const userId = this.lastID;
            issueTokenAndRedirect({
              userId,
              email,
              name: safeName,
              isAdmin: 0,
              res,
              req,
            });
          }
        );
      } else {
        // Existing user
        issueTokenAndRedirect({
          userId: row.id,
          email: row.email,
          name: row.name || nameFromGoogle || "",
          isAdmin: Number(row.is_admin) || 0,
          res,
          req,
        });
      }
    });
  }
);

// --- Helper: issue JWT + session, then redirect to /account with token & sessionId ---
function issueTokenAndRedirect(res, req, userId, email, name) {
  try {
    const token = jwt.sign({ id: userId, email, is_admin: 0 }, JWT_SECRET, { expiresIn: "180d" });

    const device = getDevice(req);
    const ip = getIP(req);
    const lastActive = new Date().toISOString();

    db.run(
      "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
      [userId, device, ip, lastActive],
      function (err2) {
        if (err2) {
          return res.redirect(`${process.env.CLIENT_URL}/login?error=session_create_failed`);
        }

        const sessionId = this.lastID;
        return res.redirect(
          `${process.env.CLIENT_URL}/account?token=${token}&sessionId=${sessionId}&name=${encodeURIComponent(name)}`
        );
      }
    );
  } catch (err) {
    return res.redirect(`${process.env.CLIENT_URL}/login?error=token_issue_failed`);
  }
}



// =================================================
// 🔹 REGISTER & LOGIN (existing)
// =================================================
app.post("/api/register", async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ message: "All fields are required" });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)`,
      [name, email, phone, hashedPassword],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) {
            return res.status(400).json({ message: "Email already exists" });
          }
          return res.status(500).json({ message: err.message });
        }
        const userId = this.lastID;
        issueTokenAndRedirect(userId, email, name, res, req);
      }
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  db.get("SELECT * FROM users WHERE email = ?", [email], async (err, row) => {
    if (err) return res.status(500).json({ message: err.message });
    if (!row) return res.status(401).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, row.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid password" });

    issueTokenAndRedirect(row.id, row.email, row.name, res, req);
  });
});

// =================================================
// ✅ Other routes (wishlist, products, etc.)
// =================================================
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

// ✅ Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

export { app, db };


