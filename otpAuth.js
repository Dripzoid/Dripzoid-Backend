// routes/otpAuth.js
import express from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";

const router = express.Router();

// Helper to hash OTP (matches current webhook: sha256(otp))
function hashOTP(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

// Ensure otpData has attempts/used columns (safe ALTER)
function ensureOtpColumns(db) {
  try {
    db.run("ALTER TABLE otpData ADD COLUMN attempts INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    db.run("ALTER TABLE otpData ADD COLUMN used INTEGER DEFAULT 0");
  } catch (e) {}
}

// POST /api/check-email
// Body: { email }
// Returns: { exists: true/false }
router.post("/check-email", (req, res) => {
  const db = req.app.locals.db;
  const email = (req.body?.email || "").toLowerCase();
  if (!email) return res.status(400).json({ message: "Email required" });

  db.get("SELECT id FROM users WHERE lower(email) = ?", [email], (err, row) => {
    if (err) {
      console.error("check-email db error:", err);
      return res.status(500).json({ message: "DB error" });
    }
    return res.json({ exists: !!row });
  });
});

// POST /api/verify-otp
// Body: { email, otp }
// Returns: { success: true/false, message }
router.post("/verify-otp", (req, res) => {
  const db = req.app.locals.db;
  ensureOtpColumns(db);

  const email = (req.body?.email || "").toLowerCase();
  const otp = String(req.body?.otp || "").trim();
  if (!email || !otp) return res.status(400).json({ success: false, message: "Email and OTP required" });

  db.get("SELECT otp_hash, otp_created_at, attempts, used FROM otpData WHERE email = ?", [email], (err, row) => {
    if (err) {
      console.error("verify-otp db get error:", err);
      return res.status(500).json({ success: false, message: "DB error" });
    }
    if (!row) {
      // maybe webhook removed it (already verified) — treat as verified to be friendly
      return res.status(400).json({ success: false, message: "OTP not found or already verified" });
    }
    const now = Math.floor(Date.now() / 1000);
    const otpValidSeconds = Number(process.env.OTP_EXPIRY_SECONDS || 300); // default 5 min

    if (row.used === 1) {
      return res.status(400).json({ success: false, message: "OTP already used" });
    }

    if (now - row.otp_created_at > otpValidSeconds) {
      // expired: delete and ask client to request a new OTP
      db.run("DELETE FROM otpData WHERE email = ?", [email], (dErr) => {
        if (dErr) console.warn("verify-otp delete expired error:", dErr);
      });
      return res.status(400).json({ success: false, message: "OTP expired" });
    }

    const hashed = hashOTP(otp);
    if (hashed === row.otp_hash) {
      // success: mark used (or delete)
      db.run("DELETE FROM otpData WHERE email = ?", [email], (dErr) => {
        if (dErr) console.warn("verify-otp delete after success error:", dErr);
      });
      return res.json({ success: true, message: "OTP verified" });
    }

    // failure: increment attempts, lock after limit
    const attempts = (row.attempts || 0) + 1;
    const maxAttempts = Number(process.env.OTP_MAX_ATTEMPTS || 5);

    db.run("UPDATE otpData SET attempts = ? WHERE email = ?", [attempts, email], (uErr) => {
      if (uErr) console.warn("verify-otp update attempts error:", uErr);
    });

    if (attempts >= maxAttempts) {
      // delete to force new flow
      db.run("DELETE FROM otpData WHERE email = ?", [email], (dErr) => {
        if (dErr) console.warn("verify-otp delete after too many attempts:", dErr);
      });
      return res.status(429).json({ success: false, message: "Too many attempts. Request a new OTP." });
    }

    return res.status(400).json({ success: false, message: "Invalid OTP" });
  });
});

// POST /api/complete-registration
// Body: { name, email, password, mobile }
// Only allowed if email does not already exist and ideally OTP verified earlier (we rely on client verifying first)
router.post("/complete-registration", async (req, res) => {
  const db = req.app.locals.db;
  const { name = "", email = "", password = "", mobile = "" } = req.body;

  if (!email || !password) return res.status(400).json({ message: "Email and password required" });

  const normalized = String(email).toLowerCase();

  // check if user already exists
  db.get("SELECT id FROM users WHERE lower(email) = ?", [normalized], async (err, row) => {
    if (err) {
      console.error("complete-registration db get error:", err);
      return res.status(500).json({ message: "DB error" });
    }
    if (row) return res.status(409).json({ message: "Email already registered" });

    try {
      const hashed = await bcrypt.hash(password, 10);

      db.run(
        "INSERT INTO users (name, email, phone, password, is_admin, created_at) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)",
        [name || null, normalized, mobile || null, hashed],
        function (insErr) {
          if (insErr) {
            console.error("complete-registration insert error:", insErr);
            return res.status(500).json({ message: "DB insert failed" });
          }

          // If users table has 'verified' column, set it to 1
          db.run("UPDATE users SET verified = 1 WHERE id = ?", [this.lastID], (uErr) => {
            if (uErr) console.warn("complete-registration update verified:", uErr);
          });

          return res.json({ message: "Registration complete", userId: this.lastID });
        }
      );
    } catch (hashErr) {
      console.error("complete-registration hash error:", hashErr);
      return res.status(500).json({ message: "Server error" });
    }
  });
});

export default router;
