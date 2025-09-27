// routes/shipping.js
import express from "express";
import { checkServiceability } from "./shiprocket.js";

const router = express.Router();

// GET /api/shipping/estimate?pin=DEST_PIN&cod=1
router.get("/estimate", async (req, res) => {
  const { pin, cod } = req.query;

  if (!pin) return res.status(400).json({ success: false, message: "Destination pin required" });

  try {
    const estimate = await checkServiceability(pin, cod === "1");
    res.json({ success: true, estimate });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
