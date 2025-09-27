// routes/shipping.js
import express from "express";
import { checkServiceability } from "./shiprocket.js"; // make sure path is correct

const router = express.Router();

/**
 * GET /api/shipping/estimate?pin=DEST_PIN&cod=1
 * Returns available couriers for a destination pincode
 */
router.get("/estimate", async (req, res) => {
  const { pin, cod } = req.query;

  if (!pin) {
    return res.status(400).json({
      success: false,
      message: "Destination pin (pin) is required",
    });
  }

  // Convert COD param to boolean (default true)
  const codBoolean = cod === undefined ? true : cod === "1" || cod === "true";

  try {
    const estimate = await checkServiceability(pin, codBoolean);

    res.json({
      success: true,
      estimate, // array of available couriers
      count: estimate.length, // optional: number of available options
    });
  } catch (err) {
    console.error("Shipping Estimate Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch shipping estimate",
      error: err.message,
    });
  }
});

export default router;
