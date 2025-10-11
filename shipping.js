// routes/shipping.js
import express from "express";
import { checkServiceability, trackOrder, generateInvoice } from "./shiprocket.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js"; // ensure this path is correct for your project

// Define __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * POST /api/shipping/download-invoice
 * Body:
 *   - order_id (your local order ID)
 *
 * This route:
 *   1. Fetches the corresponding Shiprocket order_id from your DB
 *   2. Generates the invoice via Shiprocket API (returns PDF URL)
 *   3. Downloads the PDF and returns it to frontend
 */
router.post("/download-invoice", async (req, res) => {
  try {
    let { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({ success: false, message: "order_id is required" });
    }

    order_id = parseInt(order_id, 10);
    if (isNaN(order_id)) {
      return res.status(400).json({ success: false, message: "order_id must be a number" });
    }

    // ---------------- Fetch Shiprocket order_id from DB ----------------
    const row = await new Promise((resolve, reject) => {
      db.get("SELECT shiprocket_order_id FROM orders WHERE id = ?", [order_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const shiprocketOrderId = row?.shiprocket_order_id ? String(row.shiprocket_order_id).trim() : null;
    if (!shiprocketOrderId) {
      return res.status(404).json({
        success: false,
        message: "Shiprocket order_id not found for this order",
      });
    }

    // ---------------- Generate invoice via Shiprocket API ----------------
    const invoiceData = await generateInvoice(shiprocketOrderId);

    if (!invoiceData?.invoice_url) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate invoice or missing invoice URL",
      });
    }

    const invoiceUrl = invoiceData.invoice_url;

    // ---------------- Download the invoice PDF ----------------
    const response = await axios.get(invoiceUrl, { responseType: "arraybuffer", timeout: 20000 });

    // Optional: save locally if you want
    const invoicesDir = path.join(__dirname, "../invoices");
    const invoiceFileName = `invoice_${shiprocketOrderId}.pdf`;
    const invoicePath = path.join(invoicesDir, invoiceFileName);

    // Ensure folder exists and write file
    fs.mkdirSync(invoicesDir, { recursive: true });
    fs.writeFileSync(invoicePath, response.data);

    // ---------------- Send file to frontend ----------------
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoiceFileName}"`);
    return res.send(response.data);
  } catch (err) {
    console.error("Route /api/shipping/download-invoice error:", err);
    return res.status(500).json({
      success: false,
      message: err?.message || "Failed to download invoice",
    });
  }
});

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
      return res.status(400).json({ success: false, message: "pin (delivery_postcode) is required" });
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
      pickup_postcode: process.env.WAREHOUSE_PIN || process.env.WAREHOUSE_PINCODE || 533450,
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
      message: err?.message || "Server error",
    });
  }
});

/**
 * POST /api/shipping/track-order
 * Body:
 *  - order_id (required) → your local order ID
 *
 * This route:
 *   1. Looks up the corresponding Shiprocket order_id in your DB
 *   2. Tracks the shipment using Shiprocket's tracking API
 */
router.post("/track-order", async (req, res) => {
  try {
    let { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({ success: false, message: "order_id is required" });
    }

    // Ensure order_id is a number
    order_id = parseInt(order_id, 10);
    if (isNaN(order_id)) {
      return res.status(400).json({ success: false, message: "order_id must be a number" });
    }

    // ----------------- Fetch row from DB -----------------
    const row = await new Promise((resolve, reject) => {
      db.get("SELECT shiprocket_order_id FROM orders WHERE id = ?", [order_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const shiprocketOrderId = row?.shiprocket_order_id ? String(row.shiprocket_order_id).trim() : null;
    if (!shiprocketOrderId) {
      return res.status(404).json({
        success: false,
        message: "Shiprocket order_id not found for this order",
      });
    }

    // ----------------- Fetch tracking from Shiprocket -----------------
    const trackingData = await trackOrder({ order_id: shiprocketOrderId });

    // ----------------- Respond -----------------
    return res.json({
      success: true,
      message: "Tracking information retrieved successfully",
      tracking: trackingData,
    });
  } catch (err) {
    console.error("Route /api/shipping/track-order error:", err);
    return res.status(500).json({
      success: false,
      message: err?.message || "Failed to fetch tracking data",
    });
  }
});

export default router;
