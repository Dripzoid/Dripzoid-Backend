// OtpVerification.js
import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cors from "cors";

dotenv.config();

const router = express.Router();
const db = new Database(process.env.DATABASE_FILE);

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
// Example: router.post("/send-otp", ...)
router.post("/send-otp", async (req, res) => {
  try {
    const email = (req.body?.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ success: false, message: "Email required" });

    // required env vars
    const AUTHKEY = process.env.MSG91_AUTHKEY;
    const SENDER = process.env.MSG91_EMAIL_SENDER;       // e.g. "no-reply@yourdomain.com"
    const TEMPLATE_ID = process.env.MSG91_EMAIL_TEMPLATE; // template id (string or numeric depending on control API)
    const DOMAIN = process.env.MSG91_DOMAIN || "dripzoid.com";
    const LOGO_URL = process.env.MSG91_LOGO_URL || "";   // logo url to pass into template

    if (!AUTHKEY || !SENDER || !TEMPLATE_ID) {
      console.error("MSG91 env variables missing:", { AUTHKEY: !!AUTHKEY, SENDER: !!SENDER, TEMPLATE_ID: !!TEMPLATE_ID });
      return res.status(500).json({ success: false, message: "Server not configured to send OTP (MSG91 missing)." });
    }

    // generate 6-digit OTP (crypto not strictly necessary for 6-digit but OK)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = hashOTP(otp);
    const now = Math.floor(Date.now() / 1000);

    // store/replace OTP record in otpData table
    db.prepare(`
      INSERT INTO otpData (email, otp_hash, otp_created_at, attempts)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(email) DO UPDATE SET otp_hash=excluded.otp_hash, otp_created_at=excluded.otp_created_at, attempts=0
    `).run(email, otpHash, now);

    // Construct MSG91 request payload (include template variables required by your template)
    // IMPORTANT: variable names here must match the placeholders used inside your MSG91 template (case-sensitive)
    const payload = {
      from: { email: SENDER },
      domain: DOMAIN,
      template_id: TEMPLATE_ID,
      recipients: [
        {
          to: [{ email, name: email }],
          variables: {
            logo_url: LOGO_URL,
             otp_code: otp
          }
        }
      ]
    };

    // call MSG91 email API
    const response = await fetch("https://control.msg91.com/api/v5/email/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "authkey": AUTHKEY
      },
      body: JSON.stringify(payload)
    });

    const json = await response.json().catch(() => ({}));
    console.log("send-otp email response:", json);

    // MSG91 responds in a few formats; be defensive
    const success =
      response.ok &&
      // older/typical: { hasError: false, ... }
      (json.hasError === false ||
       // alternative: check for message code or recipients status
       (typeof json.status === "string" && /success/i.test(json.status)) ||
       // or any success flag the API returns
       json.message === "message sent" ||
       json.message === "success");

    if (success) {
      return res.json({ success: true, message: "OTP sent successfully" });
    }

    // If the provider returned an error, surface useful bits
    const errorPayload = {
      success: false,
      message: json?.message || "MSG91 responded with an error",
      details: json
    };
    console.warn("MSG91 send failed:", errorPayload);
    return res.status(400).json(errorPayload);
  } catch (err) {
    console.error("send-otp error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
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
