// routes/shipping.js
import express from "express";
import { checkServiceability } from "./shiprocket.js"; // adjust path as needed

const router = express.Router();

/**
 * GET /api/shipping/estimate
 * Query params:
 *  - pin (delivery_postcode) [required]
 *  - cod (1|0) OR order_id (conditional)
 *  - weight (in kgs, string) (conditional)
 *  - length, breadth, height (cm)
 *  - declared_value, mode, is_return, qc_check
 */
router.get("/estimate", async (req, res) => {
  try {
    const { pin, cod, weight, order_id, length, breadth, height, declared_value, mode, is_return, qc_check } = req.query;

    if (!pin) {
      return res.status(400).json({ success: false, message: "pin (delivery_postcode) is required" });
    }

    // either order_id OR (cod + weight) required — shiprocket docs
    if (!order_id && (cod === undefined && weight === undefined)) {
      return res.status(400).json({ success: false, message: "Either order_id or both cod and weight are required" });
    }

    // Disable caching for dynamic results
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    const opts = {
      order_id: order_id ?? undefined,
      cod: cod === undefined ? undefined : (String(cod) === "1" || String(cod).toLowerCase() === "true"),
      weight: weight ?? undefined,
      length: length ? Number(length) : undefined,
      breadth: breadth ? Number(breadth) : undefined,
      height: height ? Number(height) : undefined,
      declared_value: declared_value ? Number(declared_value) : undefined,
      mode: mode ?? undefined,
      is_return: is_return !== undefined ? Number(is_return) : undefined,
      qc_check: qc_check !== undefined ? Number(qc_check) : undefined,
    };

    const estimate = await checkServiceability(pin, opts.cod, opts.weight, {
      length: opts.length,
      breadth: opts.breadth,
      height: opts.height
    });

    res.json({
      success: true,
      estimate,
      count: Array.isArray(estimate) ? estimate.length : 0,
    });
  } catch (err) {
    console.error("Route /api/shipping/estimate error:", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

export default router;
