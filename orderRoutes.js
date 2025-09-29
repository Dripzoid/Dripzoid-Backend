// routes/orderRoutes.js
import express from "express";
import db from "./db.js";
import { auth } from "./auth.js";
import { createOrder } from "./shiprocket.js";

const router = express.Router();

// Helper wrappers
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// 🚀 Place Order Route
router.post("/place-order", auth, async (req, res) => {
  const {
    cartItems = [],
    items = [],
    buyNow = false,
    shippingAddress,
    paymentMethod,
    paymentDetails,
    totalAmount,
  } = req.body;

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const shippingAddrNormalized = {
    ...shippingAddress,
    country: shippingAddress?.country ?? "India",
  };

  try {
    await runQuery("BEGIN TRANSACTION");

    // Insert order into DB
    const orderInsert = await runQuery(
      `INSERT INTO orders 
       (user_id, address_id, shipping_address, payment_method, payment_details, total_amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now','localtime'))`,
      [
        userId,
        shippingAddrNormalized.id ?? null,
        JSON.stringify(shippingAddrNormalized),
        paymentMethod || "",
        JSON.stringify(paymentDetails || {}),
        totalAmount ?? 0,
      ]
    );
    const orderId = orderInsert.lastID;

    // Insert items into DB (simplified)
    for (const it of items) {
      await runQuery(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, price, selectedColor, selectedSize)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          it.product_id,
          it.quantity,
          it.price,
          it.quantity * it.price,
          it.selectedColor || null,
          it.selectedSize || null,
        ]
      );
    }

    await runQuery("COMMIT");

    // --- Build Shiprocket payload ---
    const shiprocketPayload = {
      order_id: `LOCAL-${orderId}`, // reference
      order_date: new Date().toISOString().slice(0, 19).replace("T", " "),
      pickup_location: process.env.SHIPROCKET_PICKUP || "warehouse",
      billing_customer_name: req.user?.name || "Customer",
      billing_last_name: "",
      billing_address: shippingAddrNormalized.line1,
      billing_address_2: shippingAddrNormalized.line2,
      billing_city: shippingAddrNormalized.city,
      billing_pincode: shippingAddrNormalized.pincode,
      billing_state: shippingAddrNormalized.state,
      billing_country: shippingAddrNormalized.country,
      billing_email: req.user?.email || "noreply@example.com",
      billing_phone: shippingAddrNormalized.phone,
      shipping_is_billing: true,
      order_items: items.map((it) => ({
        name: it.product_name || "Product",
        sku: `SKU-${it.product_id}`,
        units: it.quantity,
        selling_price: it.price,
      })),
      payment_method: paymentMethod?.toUpperCase() === "COD" ? "COD" : "Prepaid",
      sub_total: totalAmount,
      length: 15,
      breadth: 10,
      height: 5,
      weight: 1,
    };

    // --- Push to Shiprocket ---
    let srOrder = null;
    try {
      srOrder = await createOrder(shiprocketPayload);

      // Save shiprocket_order_id in DB
      await runQuery(
        `UPDATE orders SET shiprocket_order_id = ? WHERE id = ?`,
        [srOrder.order_id, orderId]
      );
    } catch (err) {
      console.error("⚠️ Shiprocket order creation failed:", err.message);
      // keep order locally even if Shiprocket fails
    }

    return res.json({
      success: true,
      orderId,
      shiprocket: srOrder || null,
    });
  } catch (err) {
    console.error("Order insert error:", err.message);
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr.message);
    }
    return res.status(500).json({ error: "Could not place order", details: err.message });
  }
});

export default router;
