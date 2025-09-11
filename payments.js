// routes/payments.js
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import Razorpay from "razorpay";
import db from "./db.js";

const router = express.Router();

// --- Encryption helpers ---
const ENC_KEY = process.env.ENC_KEY || "12345678901234567890123456789012"; // 32 chars
const IV = process.env.IV || "1234567890123456"; // 16 chars

function encrypt(text) {
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENC_KEY), Buffer.from(IV));
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

function decrypt(text) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENC_KEY), Buffer.from(IV));
  let decrypted = decipher.update(text, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// --- Middleware: Auth ---
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ---------------- RAZORPAY CONFIG ----------------
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.warn("Warning: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set in env. Razorpay endpoints will fail until set.");
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---------------- TABLES ----------------
db.run(
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    shipping_json TEXT,
    total_amount REAL,
    status TEXT,
    razorpay_order_id TEXT,
    razorpay_amount INTEGER,
    razorpay_payment_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`
);

db.run(
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id)
  )`
);

db.run(
  `CREATE TABLE IF NOT EXISTS user_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`
);

// ---------------- CREATE RAZORPAY ORDER ----------------
router.post("/razorpay/create-order", auth, async (req, res) => {
  try {
    const { items, shipping, totalAmount } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    const totalAmtNumber = Number(totalAmount);
    if (!Number.isFinite(totalAmtNumber) || totalAmtNumber <= 0) {
      return res.status(400).json({ error: "Invalid totalAmount" });
    }

    const amountPaise = Math.round(totalAmtNumber * 100);

    // 1️⃣ Insert order
    const orderResult = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO orders (user_id, shipping_json, total_amount, status) 
         VALUES (?, ?, ?, ?)`,
        [req.user.id, JSON.stringify(shipping || {}), totalAmtNumber, "Pending"],
        function (err) {
          if (err) return reject(err);
          resolve({ id: this.lastID });
        }
      );
    });

    // 2️⃣ Insert items into order_items
// 2️⃣ Insert items into order_items
for (const item of items) {
  const unitPrice = Number(item.unit_price || item.price || 0);
  const quantity = Number(item.quantity || 1);
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, price, selectedColor, selectedSize) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderResult.id,
        item.product_id,
        quantity,
        unitPrice,
        unitPrice * quantity,
        item.selectedColor ?? null,
        item.selectedSize ?? null,
      ],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}


    // 3️⃣ Create Razorpay order
    const razorOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `order_rcptid_${orderResult.id}`,
      notes: { internalOrderId: orderResult.id.toString() },
    });

    // 4️⃣ Update order with Razorpay info
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE orders SET razorpay_order_id = ?, razorpay_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [razorOrder.id, razorOrder.amount, orderResult.id],
        function (err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    // 5️⃣ Insert user activity (Placed order)
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_activity (user_id, action) VALUES (?, ?)`,
        [req.user.id, `Placed order #${orderResult.id}`],
        function (err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    res.json({
      razorpayOrderId: razorOrder.id,
      amount: razorOrder.amount,
      currency: razorOrder.currency,
      internalOrderId: orderResult.id,
    });
  } catch (err) {
    console.error("Razorpay create-order error:", err);
    res.status(500).json({ error: "Failed to create Razorpay order" });
  }
});

// ---------------- VERIFY RAZORPAY PAYMENT ----------------
router.post("/razorpay/verify", auth, async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, internalOrderId } = req.body;

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !internalOrderId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Signature verification failed" });
    }

    // Update order status to paid
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE orders 
         SET status = ?, razorpay_payment_id = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ? AND user_id = ?`,
        ["Confirmed", razorpay_payment_id, internalOrderId, req.user.id],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) return reject(new Error("Order not found or not owned by user"));
          resolve();
        }
      );
    });

    // Insert user activity (Payment successful)
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_activity (user_id, action) VALUES (?, ?)`,
        [req.user.id, `Payment successful for order #${internalOrderId}`],
        function (err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    res.json({ success: true, internalOrderId, razorpay_payment_id });
  } catch (err) {
    console.error("Razorpay verify error:", err);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});

export default router;


