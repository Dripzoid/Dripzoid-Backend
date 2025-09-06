// OtpVerification.js
import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config(); // Load .env variables

const router = express.Router();

// Open SQLite DB
const db = new Database("./dripzoid.db");

// Ensure otpData table exists (temporary OTP storage)
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

// Hash OTP
function hashOTP(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

// OTP webhook endpoint
router.post("/otp-webhook", (req, res) => {
  try {
    // Validate secret
    const incomingSecret = req.headers["x-msg91-secret"];
    const MSG91_SECRET = process.env.MSG91_SECRET;
    if (!incomingSecret || incomingSecret !== MSG91_SECRET) {
      console.log("Unauthorized webhook attempt");
      return res.status(401).send("Unauthorized");
    }

    const { type, mobile, otp } = req.body;
    const emailOrMobile = mobile;

    console.log(
      `[Webhook] Event: ${type}, Email/Mobile: ${maskEmail(emailOrMobile)}, OTP: ${maskOTP(otp)}`
    );

    switch (type) {
      case "OTP_SENT": {
        const otpHash = hashOTP(otp);
        const now = Math.floor(Date.now() / 1000);

        // Insert or update OTP in otpData table
        const stmt = db.prepare(`
          INSERT INTO otpData (email, otp_hash, otp_created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET otp_hash = excluded.otp_hash, otp_created_at = excluded.otp_created_at
        `);
        stmt.run(emailOrMobile, otpHash, now);

        console.log(`OTP stored in otpData for ${maskEmail(emailOrMobile)}`);
        break;
      }

      case "OTP_VERIFIED": {
        // Optionally remove the OTP after verification
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

export default router;
