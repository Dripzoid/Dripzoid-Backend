// routes/payments.js
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import Razorpay from "razorpay";
import db from "./db.js";
import { createOrder as createShiprocketOrder, checkServiceability } from "./shiprocket.js";

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
  console.warn(
    "Warning: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set in env. Razorpay endpoints will fail until set."
  );
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
    shiprocket_order_id TEXT,
    delivery_date TEXT,
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
    selectedColor TEXT,
    selectedSize TEXT,
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

router.post("/razorpay/create-order", auth, async (req, res) => {
  const { items, shipping, totalAmount } = req.body;

  if (!items?.length) {
    return res.status(400).json({ error: "No items provided" });
  }

  const amount = Math.round(Number(totalAmount) * 100);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  try {
    const orderId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO orders (user_id, shipping_json, total_amount, status)
         VALUES (?, ?, ?, 'Pending')`,
        [req.user.id, JSON.stringify(shipping), totalAmount],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    // insert items
    for (const item of items) {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO order_items 
           (order_id, product_id, quantity, unit_price, price)
           VALUES (?, ?, ?, ?, ?)`,
          [
            orderId,
            item.product_id,
            item.quantity,
            item.unit_price,
            item.unit_price * item.quantity,
          ],
          (err) => (err ? reject(err) : resolve())
        );
      });
    }

    const razorOrder = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `order_${orderId}`,
      notes: { internalOrderId: orderId.toString() },
    });

    await db.run(
      `UPDATE orders 
       SET razorpay_order_id = ?, razorpay_amount = ?
       WHERE id = ?`,
      [razorOrder.id, razorOrder.amount, orderId]
    );

    res.json({
      success: true,
      internalOrderId: orderId,
      razorpayOrderId: razorOrder.id,
      amount: razorOrder.amount,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Create order failed" });
  }
});

// ---------------- VERIFY RAZORPAY PAYMENT ----------------
router.post("/razorpay/verify", auth, async (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    internalOrderId
  } = req.body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // ✅ 1. Fetch order
    const order = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM orders WHERE id = ?`, [internalOrderId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!order) return res.status(404).json({ error: "Order not found" });

    // ✅ 2. Idempotency check
    if (order.status === "Confirmed") {
      return res.json({
        success: true,
        message: "Already processed",
        shiprocketOrderId: order.shiprocket_order_id
      });
    }

    // ✅ 3. Verify signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    // ✅ 4. Validate order mapping
    if (order.razorpay_order_id !== razorpay_order_id) {
      return res.status(400).json({ error: "Order mismatch" });
    }

    // ✅ 5. Fetch payment from Razorpay
    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    if (payment.status !== "captured") {
      return res.status(400).json({ error: "Payment not captured" });
    }

    // ✅ 6. Get items
    const items = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM order_items WHERE order_id = ?`, [internalOrderId], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    const address = JSON.parse(order.shipping_json);

    // ✅ 7. Create Shiprocket order (SAFE)
    let shiprocketOrder = null;

    try {
      shiprocketOrder = await createShiprocketOrder({
        order_id: `ORDER-${internalOrderId}`,
        order_date: new Date().toISOString().slice(0, 19).replace("T", " "),
        pickup_location: process.env.SHIPROCKET_PICKUP || "PRIMARY",
        billing_customer_name: address.name || "Customer",
        billing_address: address.address || "N/A",
        billing_city: address.city,
        billing_pincode: address.pincode,
        billing_state: address.state,
        billing_country: "India",
        billing_email: address.email,
        billing_phone: address.phone,
        shipping_is_billing: true,
        payment_method: "Prepaid",
        sub_total: order.total_amount,
        order_items: items.map(i => ({
          name: `Product ${i.product_id}`,
          sku: `SKU-${i.product_id}`,
          units: i.quantity,
          selling_price: i.unit_price,
        })),
        weight: 1,
      });
    } catch (err) {
      console.error("Shiprocket failed:", err);
    }

    // ✅ 8. Update DB safely
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE orders 
         SET status = ?, razorpay_payment_id = ?, shiprocket_order_id = ?
         WHERE id = ?`,
        [
          shiprocketOrder ? "Confirmed" : "Processing",
          razorpay_payment_id,
          shiprocketOrder?.order_id || null,
          internalOrderId
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });

    res.json({
      success: true,
      shiprocketOrderId: shiprocketOrder?.order_id || null
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed" });
  }
});

router.post("/razorpay/webhook", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  const shasum = crypto.createHmac("sha256", secret);
  shasum.update(JSON.stringify(req.body));

  if (shasum.digest("hex") !== req.headers["x-razorpay-signature"]) {
    return res.status(400).send("Invalid webhook");
  }

  const event = req.body.event;

  if (event === "payment.captured") {
    console.log("Webhook payment captured:", req.body.payload.payment.entity.id);
    // You can trigger verify logic here
  }

  res.json({ status: "ok" });
});

export default router;
