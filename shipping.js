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

    // Per Shiprocket docs: either order_id OR (cod + weight) is required.
    // To make weight optional for callers, we accept cod and default weight to 1kg when missing.
    if (!order_id && (codRaw === undefined)) {
      return res.status(400).json({
        success: false,
        message:
          "Either order_id or cod must be provided. Weight will default to 1 kg if omitted.",
      });
    }

    // Disable caching for dynamic results
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    // Normalize/convert incoming params
    const cod = codRaw !== undefined
      ? (String(codRaw) === "1" || String(codRaw).toLowerCase() === "true" ? 1 : 0)
      : undefined;

    // Default weight to 1 kg if not provided
    let weight = weightRaw !== undefined ? Number(weightRaw) : 1;
    if (!Number.isFinite(weight) || weight <= 0) weight = 1;

    const opts = {
      order_id: order_id ?? undefined,
      cod: cod,
      weight: weight,
      length: length ? Number(length) : 15, // sensible defaults
      breadth: breadth ? Number(breadth) : 10,
      height: height ? Number(height) : 5,
      declared_value: declared_value ? Number(declared_value) : 100,
      mode: mode ?? undefined,
      is_return: is_return !== undefined ? Number(is_return) : 0, // required by API (0 = not a return)
      qc_check: qc_check !== undefined ? Number(qc_check) : 0,
    };

    // Forward to serviceability checker (shiprocket.js expects an opts object)
    const estimate = await checkServiceability(pin, opts);

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
