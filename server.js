// backend/server.js
import dotenv from "dotenv";
dotenv.config(); // ✅ Load environment variables

import express from "express";
import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import { v2 as cloudinary } from "cloudinary";

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
import votesRouter from "./votes.js"; // ✅ NEW
import { UAParser } from "ua-parser-js";



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // parse urlencoded bodies

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || "Dripzoid.App@2025";

// ✅ Cloudinary Configuration (only if env variables provided)
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} else {
  console.warn("⚠️ Cloudinary environment variables are not fully set. Uploads will fail until configured.");
}

// ✅ SQLite connection (graceful)
const dbPath = path.join(__dirname, "dripzoid.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ SQLite connection error:", err.message);
  else console.log("✅ Connected to SQLite database at", dbPath);
});

// Make db available to routes via app.locals (some route files may import their own db; this is a helpful fallback)
app.locals.db = db;

// ✅ JWT Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ message: "No token provided" });

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Invalid token format" });
  }

  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid or expired token" });
    req.user = user;
    next();
  });
}

// ================== AUTH ROUTES ==================

// Register

// Helper functions
function getDevice(req) {
  const parser = new UAParser(req.headers["user-agent"]);
  const device = parser.getDevice().model || parser.getOS().name || "Unknown Device";
  const browser = parser.getBrowser().name || "";
  return `${device} ${browser}`.trim();
}

function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress || "Unknown IP";
}

// ---------------- REGISTER ----------------
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
        const token = jwt.sign({ id: userId, email, is_admin: 0 }, JWT_SECRET, {
          expiresIn: "180d",
        });

        // Insert session
        const device = getDevice(req);
        const ip = getIP(req);
        const lastActive = new Date().toISOString();

        db.run(
          "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
          [userId, device, ip, lastActive],
          function (err2) {
            if (err2) {
              console.error("Failed to insert session:", err2.message);
              return res.status(500).json({ message: "Failed to create session" });
            }

            const sessionId = this.lastID; // capture session ID

            // Insert activity log
            db.run(
              "INSERT INTO user_activity (user_id, action) VALUES (?, ?)",
              [userId, "Registered and logged in"],
              (err3) => {
                if (err3) console.error("Failed to insert activity:", err3.message);
              }
            );

            res.json({
              message: "User registered successfully",
              token,
              sessionId, // return sessionId
              user: { id: userId, name, email, phone, is_admin: 0 },
            });
          }
        );
      }
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ---------------- LOGIN ----------------
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  db.get("SELECT * FROM users WHERE email = ?", [email], async (err, row) => {
    if (err) return res.status(500).json({ message: err.message });
    if (!row) return res.status(401).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, row.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid password" });

    const token = jwt.sign(
      { id: row.id, email: row.email, is_admin: row.is_admin },
      JWT_SECRET,
      { expiresIn: "180d" }
    );

    // Insert session
    const device = getDevice(req);
    const ip = getIP(req);
    const lastActive = new Date().toISOString();

    db.run(
      "INSERT INTO user_sessions (user_id, device, ip, last_active) VALUES (?, ?, ?, ?)",
      [row.id, device, ip, lastActive],
      function (err2) {
        if (err2) {
          console.error("Failed to insert session:", err2.message);
          return res.status(500).json({ message: "Failed to create session" });
        }

        const sessionId = this.lastID; // capture session ID

        // Insert activity log
        db.run(
          "INSERT INTO user_activity (user_id, action) VALUES (?, ?)",
          [row.id, "Logged in"],
          (err3) => {
            if (err3) console.error("Failed to insert activity:", err3.message);
          }
        );

        res.json({
          message: "Login successful",
          token,
          sessionId, // return sessionId
          user: {
            id: row.id,
            name: row.name,
            email: row.email,
            phone: row.phone,
            is_admin: row.is_admin,
            created_at: row.created_at,
          },
        });
      }
    );
  });
});


// Get User Profile
app.get("/api/users/:id", authenticateToken, (req, res) => {
  const requestedId = Number(req.params.id);
  const tokenUserId = Number(req.user.id);

  if (requestedId !== tokenUserId) {
    return res.status(403).json({ message: "Access denied" });
  }

  db.get(
    "SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?",
    [requestedId],
    (err, row) => {
      if (err) return res.status(500).json({ message: err.message });
      if (!row) return res.status(404).json({ message: "User not found" });

      res.json(row);
    }
  );
});

// Update User Profile
app.put("/api/users/:id", authenticateToken, (req, res) => {
  const requestedId = Number(req.params.id);
  const tokenUserId = Number(req.user.id);

  if (requestedId !== tokenUserId) {
    return res.status(403).json({ message: "Access denied" });
  }

  const { name, email, phone } = req.body;
  if (!name || !email || !phone) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const sql = `UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?`;

  db.run(sql, [name, email, phone, requestedId], function (err) {
    if (err) return res.status(500).json({ message: err.message });
    if (this.changes === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    db.get(
      "SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?",
      [requestedId],
      (err, row) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(row);
      }
    );
  });
});

// ================== FEATURE ROUTES ==================
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/products", productsRouter);
app.use("/api/cart", cartRouter);
app.use("/api/orders", orderRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/user/orders", authenticateToken, userOrdersRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/payments", paymentsRouter);
app.use("/api/account", accountSettingsRoutes);


// Admin Routes
app.use("/api/admin/products", auth, adminProductsRoutes);
app.use("/api/admin/orders", authAdmin, adminOrdersRoutes);
app.use("/api/admin", authAdmin, adminStatsRoutes);

// ✅ Reviews & Q/A Routes
app.use("/api/reviews", reviewsRouter);
app.use("/api/qa", qaRouter);
app.use("/api/votes", votesRouter);

// ✅ Health check
app.get("/test-env", (req, res) => {
  res.json({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || null,
    apiKey: !!process.env.CLOUDINARY_API_KEY,
    apiSecret: !!process.env.CLOUDINARY_API_SECRET,
    nodeEnv: process.env.NODE_ENV || "development",
  });
});

// 404 handler for unknown API routes
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ message: "API route not found" });
  next();
});

// global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
});

// ✅ Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

// Export app & db for tests or other scripts (optional)
export { app, db };


