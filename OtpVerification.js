// OtpVerification.js
import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config(); // Load .env variables

const router = express.Router();

// Open SQLite DB (sync, single connection with better-sqlite3)
const db = new Database("./dripzoid.db");

// Ensure otpData table exists
db.prepare(`
  CREATE TABLE IF NOT EXISTS otpData (
    email TEXT PRIMARY KEY,
    otp_hash TEXT NOT NULL,
    otp_created_at INTEGER NOT NULL
  )
`).run();

// Utility: Mask email
function maskEmail(email) {
  if (!email) return "";
  const [user, domain] = email.split("@");
  return user[0] + "***@" + domain;
}

// Utility: Mask OTP
function maskOTP(otp) {
  if (!otp) return "";
  return otp.slice(0, 1) + "***" + otp.slice(-1);
}

// Hash OTP with SHA256
function hashOTP(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

// -------------------- OTP WEBHOOK (MSG91 callback) --------------------
router.post("/otp-webhook", (req, res) => {
  try {
    const incomingSecret = req.headers["x-msg91-secret"];
    const MSG91_SECRET = process.env.MSG91_SECRET;

    if (!incomingSecret || incomingSecret !== MSG91_SECRET) {
      console.log("Unauthorized webhook attempt");
      return res.status(401).send("Unauthorized");
    }

    const { type, mobile, otp } = req.body;
    const emailOrMobile = mobile;

    console.log(
      `[Webhook] Event: ${type}, Target: ${maskEmail(emailOrMobile)}, OTP: ${maskOTP(
        otp
      )}`
    );

    switch (type) {
      case "OTP_SENT": {
        const otpHash = hashOTP(otp);
        const now = Math.floor(Date.now() / 1000);

        db.prepare(`
          INSERT INTO otpData (email, otp_hash, otp_created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET otp_hash=excluded.otp_hash, otp_created_at=excluded.otp_created_at
        `).run(emailOrMobile, otpHash, now);

        console.log(`OTP stored for ${maskEmail(emailOrMobile)}`);
        break;
      }

      case "OTP_VERIFIED": {
        db.prepare("DELETE FROM otpData WHERE email = ?").run(emailOrMobile);
        console.log(`OTP verified for ${maskEmail(emailOrMobile)}`);
        break;
      }

      case "OTP_FAILED":
        console.log(`OTP failed for ${maskEmail(emailOrMobile)}`);
        break;

      default:
        console.log("Unknown OTP event type");
    }

    res.status(200).send("Received");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

// -------------------- VERIFY OTP ACCESS TOKEN --------------------
// POST /api/verify-access-token
// Body: { token }
router.post("/verify-access-token", async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ success: false, message: "Token required" });

    const url = "https://control.msg91.com/api/v5/widget/verifyAccessToken";
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const body = {
      authkey: process.env.MSG91_AUTHKEY,
      "access-token": token,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const json = await response.json();
    console.log("verify-access-token response:", json);

    if (json && json.status === "success") {
      return res.json({ success: true, data: json });
    }

    return res.status(400).json({ success: false, data: json });
  } catch (err) {
    console.error("verify-access-token error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;
