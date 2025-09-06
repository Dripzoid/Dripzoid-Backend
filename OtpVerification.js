// OtpVerification.js
import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config(); // Load .env variables

const router = express.Router();
const db = new Database("./dripzoid.db");

// Ensure otpData table exists
db.prepare(`
  CREATE TABLE IF NOT EXISTS otpData (
    email TEXT PRIMARY KEY,
    otp_hash TEXT NOT NULL,
    otp_created_at INTEGER NOT NULL
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

const OTP_VALIDITY = 5 * 60; // 5 minutes

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
    const emailOrMobile = req.body?.email?.toLowerCase() || req.body?.mobile;
    if (!emailOrMobile) return res.status(400).json({ message: "Email or mobile required" });

    // Generate random 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Hash OTP and store in DB
    const otpHash = hashOTP(otp);
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO otpData (email, otp_hash, otp_created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET otp_hash=excluded.otp_hash, otp_created_at=excluded.otp_created_at
    `).run(emailOrMobile, otpHash, now);

    // Send OTP via MSG91
    const msg91Response = await fetch("https://control.msg91.com/api/v5/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: process.env.MSG91_AUTHKEY },
      body: JSON.stringify({
        template_id: process.env.MSG91_OTP_TEMPLATE_ID,
        mobile: emailOrMobile,
        otp: otp,
      }),
    });

    const json = await msg91Response.json();
    console.log("send-otp response:", json);

    if (json.type === "success") {
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
    const emailOrMobile = req.body?.email?.toLowerCase() || req.body?.mobile;
    const otp = req.body?.otp;

    if (!emailOrMobile || !otp)
      return res.status(400).json({ success: false, message: "Email/mobile and OTP required" });

    const row = db.prepare("SELECT otp_hash, otp_created_at FROM otpData WHERE email = ?").get(emailOrMobile);
    if (!row) return res.status(400).json({ success: false, message: "No OTP found" });

    const now = Math.floor(Date.now() / 1000);
    if (now - row.otp_created_at > OTP_VALIDITY)
      return res.status(400).json({ success: false, message: "OTP expired" });

    if (row.otp_hash !== hashOTP(otp))
      return res.status(400).json({ success: false, message: "Invalid OTP" });

    // OTP verified, delete from DB
    db.prepare("DELETE FROM otpData WHERE email = ?").run(emailOrMobile);

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
    const MSG91_SECRET = process.env.MSG91_SECRET;

    if (!incomingSecret || incomingSecret !== MSG91_SECRET) {
      console.log("Unauthorized webhook attempt");
      return res.status(401).send("Unauthorized");
    }

    const { type, mobile, otp } = req.body;
    const emailOrMobile = mobile;

    console.log(
      `[Webhook] Event: ${type}, Target: ${maskEmail(emailOrMobile)}, OTP: ${maskOTP(otp)}`
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
        break;
      }
      case "OTP_VERIFIED":
        db.prepare("DELETE FROM otpData WHERE email = ?").run(emailOrMobile);
        break;
      case "OTP_FAILED":
        break;
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
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        authkey: process.env.MSG91_AUTHKEY,
        "access-token": token,
      }),
    });

    const json = await response.json();
    console.log("verify-access-token response:", json);

    if (json?.status === "success") {
      return res.json({ success: true, data: json });
    }

    return res.status(400).json({ success: false, data: json });
  } catch (err) {
    console.error("verify-access-token error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;
