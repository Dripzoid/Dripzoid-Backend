// server/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Connect to DB
const DB_PATH = path.join(__dirname, "./dripzoid.db");
const DB = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("❌ Failed to connect to database:", err.message);
  } else {
    console.log("✅ Connected to database:", DB_PATH);
  }
});

// Make sure users table exists
DB.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    phone TEXT,
    password TEXT,
    is_admin INTEGER DEFAULT 0
  )
`);

const JWT_SECRET = process.env.JWT_SECRET || "dripzoid_local_secret";

/* -------------------- REGISTER -------------------- */
router.post("/register", (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email & password are required" });
  }

  DB.get("SELECT * FROM users WHERE email = ?", [email], async (err, existing) => {
    if (err) {
      console.error("❌ DB Select Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
    if (existing) {
      return res.status(400).json({ error: "Email already registered" });
    }

    try {
      const hashed = await bcrypt.hash(password, 10);

      DB.run(
        `INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, 0)`,
        [name || "", email, phone || "", hashed],
        function (err) {
          if (err) {
            console.error("❌ DB Insert Error:", err.message);
            return res.status(500).json({ error: err.message });
          }

          return res.status(201).json({
            message: "User registered successfully",
            userId: this.lastID,
            user: {
              id: this.lastID,
              name: name || "",
              email,
              phone: phone || "",
              is_admin: false,
            },
          });
        }
      );
    } catch (hashErr) {
      console.error("❌ Password Hash Error:", hashErr.message);
      return res.status(500).json({ error: "Password hashing failed" });
    }
  });
});

/* -------------------- LOGIN -------------------- */
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  DB.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
    if (err) {
      console.error("❌ DB Select Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    try {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const token = jwt.sign(
        { id: user.id, is_admin: Boolean(user.is_admin) },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      delete user.password;
      user.is_admin = Boolean(user.is_admin);

      return res.json({
        message: "Login successful",
        token,
        user,
      });
    } catch (compareErr) {
      console.error("❌ Password Compare Error:", compareErr.message);
      return res.status(500).json({ error: "Login process failed" });
    }
  });
});

export default router;
