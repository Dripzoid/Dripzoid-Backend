// routes/shipping.js
import express from "express";
import { checkServiceability, trackOrder } from "./shiprocket.js"; // ✅ include trackOrder
import db from "./db.js"; // adjust path (assuming you’re using sqlite/mysql/pg, etc.)


const router = express.Router();

/**
 * GET /api/shipping/estimate
 * Query params:
 *  - pin (delivery_postcode) [required]
 *  - cod (1|0) OR order_id (conditional)
 *  - weight (in kgs) [optional; defaults to 1kg]
 *  - length, breadth, height (cm)
 *  - declared_value, mode, is_return, qc_check
 */
router.get("/estimate", async (req, res) => {
  try {
    const {
      pin,
      cod: codRaw,
      weight: weightRaw,
      order_id,
      length,
      breadth,
      height,
      declared_value,
      mode,
      is_return,
      qc_check,
    } = req.query;

    if (!pin) {
      return res
        .status(400)
        .json({ success: false, message: "pin (delivery_postcode) is required" });
    }

    // Either order_id OR both cod and weight must be provided
    if (!order_id && codRaw === undefined) {
      return res.status(400).json({
        success: false,
        message: "Either order_id or both cod and weight must be provided.",
      });
    }

    // Normalize parameters
    const cod =
      codRaw !== undefined
        ? String(codRaw) === "1" || String(codRaw).toLowerCase() === "true"
          ? 1
          : 0
        : 0; // default 0 if missing

    const weight = weightRaw ? String(weightRaw) : "1"; // default 1kg
    const shipmentLength = length ? Number(length) : 15;
    const shipmentBreadth = breadth ? Number(breadth) : 10;
    const shipmentHeight = height ? Number(height) : 5;

    const opts = {
      order_id: order_id ?? undefined,
      cod,
      weight,
      length: shipmentLength,
      breadth: shipmentBreadth,
      height: shipmentHeight,
      declared_value: declared_value ? Number(declared_value) : 100,
      mode: mode ?? undefined,
      is_return: is_return !== undefined ? Number(is_return) : 0,
      qc_check: qc_check !== undefined ? Number(qc_check) : 0,
      pickup_postcode: process.env.WAREHOUSE_PIN || 533450,
      delivery_postcode: Number(pin),
    };

    // Disable caching
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    // Call Shiprocket serviceability
    const estimate = await checkServiceability(Number(pin), opts);

    return res.json({
      success: true,
      estimate,
      count: Array.isArray(estimate) ? estimate.length : 0,
    });
  } catch (err) {
    console.error("Route /api/shipping/estimate error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});

/**
 * GET /api/shipping/track-order
 * Query params:
 *  - order_id (required) → your local order ID
 *
 * This route:
 *   1. Looks up the corresponding Shiprocket order_id in your DB
 *   2. Tracks the shipment using Shiprocket's tracking API
 */
// ------------------ Track Order ------------------
router.post("/track-order", async (req, res) => {
  try {
    const { order_id } = req.body; // ✅ read from body (frontend sends in POST)

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: "order_id is required",
      });
    }

    // 1️⃣ Lookup Shiprocket order_id from local DB
    const sql = `SELECT shiprocket_order_id FROM orders WHERE id = ? LIMIT 1`;
    const [rows] = await db.query(sql, [order_id]);
    const row = rows?.[0] || rows; // handles both array and object results (MySQL vs SQLite)

    if (!row || !row.shiprocket_order_id) {
      return res.status(404).json({
        success: false,
        message: "Shiprocket order_id not found for this order",
      });
    }

    const shiprocketOrderId = row.shiprocket_order_id;

    // 2️⃣ Fetch tracking info from Shiprocket
    const trackingData = await trackOrder(shiprocketOrderId);

    // 3️⃣ Respond with structured tracking data
    return res.json({
      success: true,
      message: "Tracking information retrieved successfully",
      tracking: trackingData,
    });
  } catch (err) {
    console.error("Route /api/shipping/track-order error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch tracking data",
    });
  }
});


export default router;
