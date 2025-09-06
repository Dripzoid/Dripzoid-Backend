// OtpVerification.js
import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cors from "cors";

dotenv.config();

const router = express.Router();
const db = new Database(process.env.DATABASE_FILE || "./dripzoid.db");

// Enable CORS for frontend
router.use(cors({ origin: process.env.CLIENT_URL || "*" }));

// -------------------- DB Setup --------------------
db.prepare(`
  CREATE TABLE IF NOT EXISTS otpData (
    email TEXT PRIMARY KEY,
    otp_hash TEXT NOT NULL,
    otp_created_at INTEGER NOT NULL,
    attempts INTEGER DEFAULT 0
  )
`).run();

// -------------------- Utilities --------------------
const maskEmail = (email) => {
  if (!email) return "";
  const [user, domain] = email.split("@");
  return user[0] + "***@" + domain;
};

const maskOTP = (otp) => (otp ? otp.slice(0, 1) + "***" + otp.slice(-1) : "");

const hashOTP = (otp) => crypto.createHash("sha256").update(String(otp)).digest("hex");

const OTP_VALIDITY = parseInt(process.env.OTP_EXPIRY_SECONDS) || 300;
const OTP_MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS) || 3;

// -------------------- CHECK EMAIL --------------------
router.post("/check-email", (req, res) => {
  try {
    const email = (req.body?.email || "").toLowerCase();
    if (!email) return res.status(400).json({ message: "Email required" });

    const row = db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(email);
    return res.json({ exists: !!row });
  } catch (err) {
    console.error("check-email error:", err);
    res.status(500).json({ message: "DB error" });
  }
});

// -------------------- SEND OTP --------------------
router.post("/send-otp", async (req, res) => {
  try {
    const email = (req.body?.email || "").toLowerCase();
    if (!email) return res.status(400).json({ message: "Email required" });

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = hashOTP(otp);
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO otpData (email, otp_hash, otp_created_at, attempts)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(email) DO UPDATE SET otp_hash=excluded.otp_hash, otp_created_at=excluded.otp_created_at, attempts=0
    `).run(email, otpHash, now);

    // Send via MSG91 Email API
    const response = await fetch("https://control.msg91.com/api/v5/email/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "authkey": process.env.MSG91_AUTHKEY
      },
      body: JSON.stringify({
        sender: process.env.MSG91_EMAIL_SENDER,
        template: process.env.MSG91_EMAIL_TEMPLATE,
        recipients: [
          { to: [{ email, name: email }], variables: { OTP: otp } }
        ]
      })
    });

    const json = await response.json();
    console.log("send-otp email response:", json);

    if (!json.hasError) {
      return res.json({ success: true, message: "OTP sent successfully" });
    }

    return res.status(400).json({ success: false, data: json });
  } catch (err) {
    console.error("send-otp error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- VERIFY OTP --------------------
router.post("/verify-otp", (req, res) => {
  try {
    const email = (req.body?.email || "").toLowerCase();
    const otp = req.body?.otp;

    if (!email || !otp)
      return res.status(400).json({ success: false, message: "Email and OTP required" });

    const row = db.prepare("SELECT otp_hash, otp_created_at, attempts FROM otpData WHERE email = ?").get(email);
    if (!row) return res.status(400).json({ success: false, message: "No OTP found" });

    const now = Math.floor(Date.now() / 1000);
    if (now - row.otp_created_at > OTP_VALIDITY)
      return res.status(400).json({ success: false, message: "OTP expired" });

    if (row.attempts >= OTP_MAX_ATTEMPTS)
      return res.status(400).json({ success: false, message: "Maximum attempts reached" });

    if (row.otp_hash !== hashOTP(otp)) {
      // Increment attempts
      db.prepare("UPDATE otpData SET attempts = attempts + 1 WHERE email = ?").run(email);
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // OTP verified, delete from DB
    db.prepare("DELETE FROM otpData WHERE email = ?").run(email);

    return res.json({ success: true, message: "OTP verified successfully" });
  } catch (err) {
    console.error("verify-otp error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- OTP WEBHOOK --------------------
router.post("/otp-webhook", (req, res) => {
  try {
    const incomingSecret = req.headers["x-msg91-secret"];
    if (!incomingSecret || incomingSecret !== process.env.MSG91_SECRET) {
      console.log("Unauthorized webhook attempt");
      return res.status(401).send("Unauthorized");
    }

    const { type, email, otp } = req.body;
    if (!email) return res.status(400).send("Email required");

    console.log(`[Webhook] Event: ${type}, Target: ${maskEmail(email)}, OTP: ${maskOTP(otp)}`);

    switch (type) {
      case "OTP_SENT":
        db.prepare(`
          INSERT INTO otpData (email, otp_hash, otp_created_at, attempts)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(email) DO UPDATE SET otp_hash=excluded.otp_hash, otp_created_at=excluded.otp_created_at, attempts=0
        `).run(email, hashOTP(otp), Math.floor(Date.now() / 1000));
        break;

      case "OTP_VERIFIED":
        db.prepare("DELETE FROM otpData WHERE email = ?").run(email);
        break;

      case "OTP_FAILED":
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

// -------------------- VERIFY MSG91 ACCESS TOKEN --------------------
router.post("/verify-access-token", async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ success: false, message: "Token required" });

    const url = "https://control.msg91.com/api/v5/widget/verifyAccessToken";

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        authkey: process.env.MSG91_AUTHKEY,
        "access-token": token
      })
    });

    const json = await response.json();
    console.log("verify-access-token response:", json);

    if (json?.status === "success" && !json.hasError) {
      return res.json({ success: true, data: json });
    }

    return res.status(400).json({ success: false, data: json });
  } catch (err) {
    console.error("verify-access-token error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;
