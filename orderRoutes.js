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
// Place Order (corrected - robust item normalization + Shiprocket-first + DB insert)
// 🚀 Place Order Route with Serviceability
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

  // Normalize shipping address
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
    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    const normalizedItems = items.map((it, idx) => {
      const productId =
        it.product_id ??
        it.productId ??
        it.id ??
        (it.product && (it.product.id ?? it.product._id)) ??
        null;

      if (!productId) {
        throw new Error(`Item at index ${idx} missing product id`);
      }

      const unit_price = Number(it.unit_price ?? it.unitPrice ?? it.price ?? it.selling_price ?? 0) || 0;
      const quantity = Number(it.quantity ?? it.qty ?? it.units ?? 1) || 1;
      const name = it.name ?? it.product_name ?? (it.product && (it.product.name || it.product.title)) ?? `Product ${productId}`;
      const sku = it.sku ?? it.SKU ?? (it.product && it.product.sku) ?? `SKU-${productId}`;
      const selectedColor = it.selectedColor ?? it.selected_color ?? it.color ?? null;
      const selectedSize = it.selectedSize ?? it.selected_size ?? it.size ?? null;

      return {
        product_id: Number(productId),
        unit_price,
        quantity,
        name,
        sku,
        selectedColor,
        selectedSize,
        raw: it,
      };
    });

    // --- Step 0: Check serviceability for delivery ---
    let deliveryDate = null;
    try {
      const serviceability = await checkServiceability(shippingAddrNormalized.pincode, {
        weight: normalizedItems.reduce((sum, ni) => sum + (ni.weight || 1), 0),
      });

      // Pick first courier with ETD
      if (serviceability.length > 0) {
        const firstCourier = serviceability[0];
        deliveryDate = firstCourier.etd; // ETD from Shiprocket
      }
    } catch (svcErr) {
      console.warn("Serviceability check failed, continuing without delivery date:", svcErr.message);
    }

    // --- Step 1: prepare Shiprocket payload ---
    const fullName =
      shippingAddrNormalized.name ||
      req.user?.name ||
      `${req.user?.first_name || ""} ${req.user?.last_name || ""}`.trim() ||
      "Customer";
    const nameParts = fullName.trim().split(" ");
    const firstName = nameParts[0] || "Customer";
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

    const shiprocketPayload = {
      order_id: `TEMP-${Date.now()}`,
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

      order_items: normalizedItems.map((ni) => ({
        name: ni.name,
        sku: ni.sku,
        units: ni.quantity,
        selling_price: ni.unit_price,
      })),

      payment_method: paymentMethod?.toUpperCase() === "COD" ? "COD" : "Prepaid",
      sub_total: Number(totalAmount) || 0,
      total_discount: 0,

      length: 15,
      breadth: 10,
      height: 5,
      weight: 1,
    };

    // --- Step 2: Create Shiprocket order ---
    let srOrder;
    try {
      srOrder = await createOrder(shiprocketPayload);
      if (!srOrder || !srOrder.order_id) {
        return res.status(500).json({ error: "Shiprocket order creation failed", details: srOrder });
      }
    } catch (err) {
      console.error("Shiprocket createOrder error:", err);
      return res.status(500).json({ error: "Shiprocket order creation failed", details: err?.message || String(err) });
    }

    const shiprocketOrderId = srOrder.order_id;

    // --- Step 3: Insert order into DB ---
    await runQuery("BEGIN TRANSACTION");

    const orderInsert = await runQuery(
      `INSERT INTO orders 
         (user_id, address_id, shipping_address, payment_method, payment_details, total_amount, status, shiprocket_order_id, delivery_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Confirmed', ?, ?, datetime('now','localtime'))`,
      [
        userId,
        shippingAddrNormalized.id ?? null,
        JSON.stringify(shippingAddrNormalized),
        paymentMethod || "",
        JSON.stringify(paymentDetails || {}),
        totalAmount ?? 0,
        shiprocketOrderId,
        deliveryDate ?? null,
      ]
    );

    const orderId = orderInsert.lastID;

    for (const ni of normalizedItems) {
      const price = Number(ni.unit_price || 0) * Number(ni.quantity || 1);
      await runQuery(
        `INSERT INTO order_items 
           (order_id, product_id, quantity, unit_price, price, selectedColor, selectedSize)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderId, ni.product_id, ni.quantity, ni.unit_price, price, ni.selectedColor, ni.selectedSize]
      );
    }

    await runQuery("COMMIT");

    // Log user activity
    await runQuery(`INSERT INTO user_activity (user_id, action) VALUES (?, ?)`, [
      userId,
      `Placed order #${orderId}`,
    ]);

    return res.json({
      success: true,
      orderId,
      shiprocketOrderId,
      deliveryDate,
      shiprocket: srOrder,
    });
  } catch (err) {
    console.error("Place order error:", err);
    try {
      await runQuery("ROLLBACK");
    } catch (rbErr) {
      console.error("Rollback error:", rbErr);
    }

    if (err && /missing product id/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }

    return res.status(500).json({ error: "Could not place order", details: err?.message || String(err) });
  }
});

export default router;







