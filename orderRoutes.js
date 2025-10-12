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

  // ✅ Normalize shipping address
  const shippingAddrNormalized = {
    ...shippingAddress,
    name:
      shippingAddress?.name ||
      `${shippingAddress?.first_name || ""} ${shippingAddress?.last_name || ""}`.trim(),
    line1: shippingAddress?.line1 || shippingAddress?.address || "N/A",
    line2: shippingAddress?.line2 || "",
    city: shippingAddress?.city || "N/A",
    state: shippingAddress?.state || "N/A",
    country: shippingAddress?.country || "India",
    pincode: shippingAddress?.pincode || "000000",
    phone: shippingAddress?.phone || req.user?.phone || "0000000000",
  };

  try {
    // ✅ Parse and split customer name correctly before Shiprocket payload
    const fullName =
      shippingAddrNormalized.name ||
      req.user?.name ||
      `${req.user?.first_name || ""} ${req.user?.last_name || ""}`.trim() ||
      "Customer";

    const nameParts = fullName.trim().split(" ");
    const firstName = nameParts[0] || "Customer";
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

    // ✅ Build Shiprocket payload
    const shiprocketPayload = {
      order_id: `TEMP-${Date.now()}`, // temporary until DB insert
      order_date: new Date().toISOString().slice(0, 19).replace("T", " "),
      pickup_location: process.env.SHIPROCKET_PICKUP || "warehouse",
      channel_id: Number(process.env.SHIPROCKET_CHANNEL_ID || 1),

      billing_customer_name: firstName,
      billing_last_name: lastName,
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
        name: it.product_name || it.name || `Product ${it.product_id}`,
        sku: it.sku || `SKU-${it.product_id}`,
        units: it.quantity,
        selling_price: it.price,
      })),

      payment_method:
        paymentMethod?.toUpperCase() === "COD" ? "COD" : "Prepaid",
      sub_total: Number(totalAmount) || 0,
      total_discount: 0,

      // Parcel dimensions (adjust as needed)
      length: 15,
      breadth: 10,
      height: 5,
      weight: 1,
    };

    console.log("✅ Shiprocket Payload:", shiprocketPayload);

    // ✅ Step 1: Create Shiprocket order FIRST
    let srOrder;
    try {
      srOrder = await createOrder(shiprocketPayload);
      if (!srOrder?.order_id) {
        return res.status(500).json({
          error: "Shiprocket order creation failed",
          details: srOrder || "Unknown response from Shiprocket",
        });
      }
    } catch (err) {
      console.error("⚠️ Shiprocket order creation failed:", err.message);
      return res.status(500).json({
        error: "Failed to create Shiprocket order",
        details: err.message,
      });
    }

    // ✅ Step 2: Only if Shiprocket succeeded → Insert into DB
    await runQuery("BEGIN TRANSACTION");

    const orderInsert = await runQuery(
      `INSERT INTO orders 
       (user_id, address_id, shipping_address, payment_method, payment_details, total_amount, status, shiprocket_order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Confirmed', ?, datetime('now','localtime'))`,
      [
        userId,
        shippingAddrNormalized.id ?? null,
        JSON.stringify(shippingAddrNormalized),
        paymentMethod || "",
        JSON.stringify(paymentDetails || {}),
        totalAmount ?? 0,
        srOrder.order_id,
      ]
    );

    const orderId = orderInsert.lastID;

    // ✅ Step 3: Insert order items
    for (const it of items) {
      await runQuery(
        `INSERT INTO order_items 
         (order_id, product_id, quantity, unit_price, price, selectedColor, selectedSize)
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

    // ✅ Step 4: Log user activity (optional)
    await runQuery(
      `INSERT INTO user_activity (user_id, action) VALUES (?, ?)`,
      [userId, `Placed order #${orderId}`]
    );

    // ✅ Step 5: Respond to client
    return res.json({
      success: true,
      message: "Order placed successfully",
      orderId,
      shiprocketOrderId: srOrder.order_id,
      shiprocket: srOrder,
    });
  } catch (err) {
    console.error("❌ Order placement error:", err.message);
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackErr) {
      console.error("⚠️ Rollback failed:", rollbackErr.message);
    }
    return res.status(500).json({
      error: "Could not place order",
      details: err.message,
    });
  }
});

export default router;





