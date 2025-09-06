// OtpVerification.js
import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";

const router = express.Router();

// Open SQLite DB
const db = new Database("./dripzoid.db");

// Ensure columns exist (OTP handling)
try {
  db.prepare("ALTER TABLE users ADD COLUMN otp_hash TEXT").run();
} catch (err) {
  if (!err.message.includes("duplicate column")) console.error(err);
}
try {
  db.prepare("ALTER TABLE users ADD COLUMN otp_created_at INTEGER").run();
} catch (err) {
  if (!err.message.includes("duplicate column")) console.error(err);
}
try {
  db.prepare("ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0").run();
} catch (err) {
  if (!err.message.includes("duplicate column")) console.error(err);
}

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

// Mark user as verified
function markUserVerified(email) {
  const stmt = db.prepare("UPDATE users SET verified = 1 WHERE email = ?");
  const result = stmt.run(email);
  if (result.changes > 0) {
    console.log(`DB Update: User ${maskEmail(email)} marked as verified.`);
  } else {
    console.log(`DB Update: User ${maskEmail(email)} not found.`);
  }
}

// OTP webhook endpoint
router.post("/otp-webhook", (req, res) => {
  try {
    const { type, mobile, otp } = req.body;
    const emailOrMobile = mobile; // rename for clarity

    console.log(
      `[Webhook] Event: ${type}, Email/Mobile: ${maskEmail(emailOrMobile)}, OTP: ${maskOTP(otp)}`
    );

    switch (type) {
      case "OTP_SENT": {
        const otpHash = hashOTP(otp);
        const now = Math.floor(Date.now() / 1000);

        const stmt = db.prepare(`
          INSERT INTO users (email, otp_hash, otp_created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET otp_hash = excluded.otp_hash, otp_created_at = excluded.otp_created_at
        `);
        stmt.run(emailOrMobile, otpHash, now);
        console.log(`OTP stored in DB for ${maskEmail(emailOrMobile)}`);
        break;
      }

      case "OTP_VERIFIED":
        markUserVerified(emailOrMobile);
        break;

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
