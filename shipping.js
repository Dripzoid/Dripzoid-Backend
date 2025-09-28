// routes/shipping.js
import express from "express";
import { checkServiceability } from "./shiprocket.js"; // adjust path as needed

const router = express.Router();

/**
 * GET /api/shipping/estimate
 * Query params:
 *  - pin (delivery_postcode) [required]
 *  - cod (1|0) OR order_id (conditional)
 *  - weight (in kgs) (optional; defaults to 1kg)
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

    // Either order_id OR (cod + weight) is required
    if (!order_id && codRaw === undefined) {
      return res.status(400).json({
        success: false,
        message:
          "Either order_id or cod must be provided. Weight will default to 1 kg if omitted.",
      });
    }

    // Normalize parameters
    const cod = codRaw !== undefined
      ? (String(codRaw) === "1" || String(codRaw).toLowerCase() === "true" ? 1 : 0)
      : undefined;

    const weight = weightRaw !== undefined ? Number(weightRaw) : 1;

    // Default dimensions
    const shipmentLength = length ? Number(length) : 15;
    const shipmentBreadth = breadth ? Number(breadth) : 10;
    const shipmentHeight = height ? Number(height) : 5;

    const opts = {
      order_id: order_id ?? undefined,
      cod: cod,
      weight: weight > 0 ? weight : 1,
      length: shipmentLength,
      breadth: shipmentBreadth,
      height: shipmentHeight,
      declared_value: declared_value ? Number(declared_value) : 100,
      mode: mode ?? undefined,
      is_return: is_return !== undefined ? Number(is_return) : 0,
      qc_check: qc_check !== undefined ? Number(qc_check) : 0,
      pickup_postcode: process.env.WAREHOUSE_PIN || 533450, // your warehouse PIN
      delivery_postcode: Number(pin), // from query param
    };

    // Disable caching
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    // Call Shiprocket serviceability
    const estimate = await checkServiceability(opts);

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

export default router;
