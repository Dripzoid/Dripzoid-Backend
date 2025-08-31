// backend/routes/accountSettings.js
import express from "express";
import bcrypt from "bcryptjs";
import db from "../db.js"; // db.js should export an sqlite3.Database instance
import { UAParser } from "ua-parser-js";
import auth from "../middleware/auth.js"; // JWT verification middleware

const router = express.Router();

/**
 * Helper: parse device from user-agent
 * Returns a compact string like "iPhone Safari" or "Windows Chrome" or "Unknown Device"
 */
function parseDevice(userAgent) {
  try {
    const parser = new UAParser(userAgent || "");
    const deviceModel = parser.getDevice().model || "";
    const osName = parser.getOS().name || "";
    const browser = parser.getBrowser().name || "";

    // Prefer device model, fall back to OS, then include browser
    const primary = deviceModel || osName || "Unknown Device";
    return `${primary}${browser ? " — " + browser : ""}`.trim();
  } catch (err) {
    return "Unknown Device";
  }
}

/**
 * Helper: get client IP (respect x-forwarded-for if behind proxy)
 */
function getIP(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  // Express sets req.ip when trust proxy configured; fallback to connection remote address
  return req.ip || req.connection?.remoteAddress || "Unknown IP";
}

/**
 * Routes protected with `auth` which sets req.user = decoded token payload
 * (auth returns 401 with { error: "Invalid or expired token" } for bad tokens)
 */

// ---------- Get account settings ----------
router.get("/", auth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Missing user id in token" });

  db.get("SELECT email, name FROM users WHERE id = ?", [userId], (err, user) => {
    if (err) {
      console.error("DB error (users):", err.message);
      return res.status(500).json({ error: "DB error", details: err.message });
    }
    if (!user) return res.status(404).json({ error: "User not found" });

    db.get("SELECT two_fa_enabled, backup_codes FROM user_security WHERE user_id = ?", [userId], (err2, security) => {
      if (err2) {
        console.error("DB error (user_security):", err2.message);
        return res.status(500).json({ error: "Failed to fetch security", details: err2.message });
      }

      db.get(
        "SELECT email, sms, push, marketing, order_updates FROM user_notifications WHERE user_id = ?",
        [userId],
        (err3, notifications) => {
          if (err3) {
            console.error("DB error (user_notifications):", err3.message);
            return res.status(500).json({ error: "Failed to fetch notifications", details: err3.message });
          }

          db.all("SELECT id, device, ip, last_active FROM user_sessions WHERE user_id = ?", [userId], (err4, sessions) => {
            if (err4) {
              console.error("DB error (user_sessions):", err4.message);
              return res.status(500).json({ error: "Failed to fetch sessions", details: err4.message });
            }

            db.all('SELECT id, action, created_at AS "created_at" FROM user_activity WHERE user_id = ? ORDER BY created_at DESC', [userId], (err5, activity) => {
              if (err5) {
                console.error("DB error (user_activity):", err5.message);
                return res.status(500).json({ error: "Failed to fetch activity", details: err5.message });
              }

              res.json({
                user,
                security: security || { two_fa_enabled: 0, backup_codes: "[]" },
                notifications: notifications || { email: 1, sms: 0, push: 1, marketing: 0, order_updates: 1 },
                sessions: sessions || [],
                activity: activity || [],
              });
            });
          });
        }
      );
    });
  });
});

// ---------- Fetch activity ----------
router.get("/activity", auth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Missing user id in token" });

  db.all('SELECT id, action, created_at AS "created_at" FROM user_activity WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, rows) => {
    if (err) {
      console.error("DB error (user_activity):", err.message);
      return res.status(500).json({ error: "Failed to fetch activity", details: err.message });
    }
    res.json(rows || []);
  });
});

// ---------- Change password ----------
router.post("/change-password", auth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Missing user id in token" });

  const { current, newpw, confirm } = req.body;
  if (!current || !newpw || !confirm) return res.status(400).json({ error: "Missing passwords" });
  if (newpw !== confirm) return res.status(400).json({ error: "Passwords do not match" });
  if (newpw.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });

  db.get("SELECT password FROM users WHERE id = ?", [userId], async (err, row) => {
    if (err) {
      console.error("DB error (users):", err.message);
      return res.status(500).json({ error: "DB error", details: err.message });
    }
    if (!row) return res.status(404).json({ error: "User not found" });

    const match = await bcrypt.compare(current, row.password);
    if (!match) return res.status(400).json({ error: "Current password is incorrect" });

    const hashed = await bcrypt.hash(newpw, 10);
    db.run("UPDATE users SET password = ? WHERE id = ?", [hashed, userId], (err2) => {
      if (err2) {
        console.error("DB error updating password:", err2.message);
        return res.status(500).json({ error: "Failed to update password", details: err2.message });
      }

      db.run("INSERT INTO user_activity (user_id, action) VALUES (?, ?)", [userId, "Changed password"], (aErr) => {
        if (aErr) console.error("Failed to log activity (change password):", aErr.message);
        // respond regardless of activity logging result
        res.json({ success: true, message: "Password updated" });
      });
    });
  });
});

// ---------- Toggle 2FA ----------
router.post("/toggle-2fa", auth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Missing user id in token" });

  db.get("SELECT two_fa_enabled FROM user_security WHERE user_id = ?", [userId], (err, row) => {
    if (err) {
      console.error("DB error (user_security):", err.message);
      return res.status(500).json({ error: "Failed to fetch 2FA status", details: err.message });
    }

    const newEnabled = row && row.two_fa_enabled ? 0 : 1;
    const codes = newEnabled
      ? JSON.stringify(Array.from({ length: 8 }).map(() => Math.random().toString(36).slice(2, 10).toUpperCase()))
      : "[]";

    const query = row
      ? "UPDATE user_security SET two_fa_enabled = ?, backup_codes = ? WHERE user_id = ?"
      : "INSERT INTO user_security (user_id, two_fa_enabled, backup_codes) VALUES (?, ?, ?)";
    const params = row ? [newEnabled, codes, userId] : [userId, newEnabled, codes];

    db.run(query, params, (err2) => {
      if (err2) {
        console.error("DB error updating user_security:", err2.message);
        return res.status(500).json({ error: "Failed to update 2FA", details: err2.message });
      }

      db.run("INSERT INTO user_activity (user_id, action) VALUES (?, ?)", [userId, newEnabled ? "Enabled 2FA" : "Disabled 2FA"], (aErr) => {
        if (aErr) console.error("Failed to log activity (2FA):", aErr.message);
        res.json({ twoFA: newEnabled, backupCodes: JSON.parse(codes) });
      });
    });
  });
});

// ---------- Update notifications ----------
router.post("/notifications", auth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Missing user id in token" });

  const { email = 1, sms = 0, push = 1, marketing = 0, orderUpdates = 1 } = req.body;

  db.get("SELECT user_id FROM user_notifications WHERE user_id = ?", [userId], (err, row) => {
    if (err) {
      console.error("DB error (user_notifications select):", err.message);
      return res.status(500).json({ error: "Failed to fetch notifications", details: err.message });
    }

    const query = row
      ? "UPDATE user_notifications SET email=?, sms=?, push=?, marketing=?, order_updates=? WHERE user_id=?"
      : "INSERT INTO user_notifications (user_id, email, sms, push, marketing, order_updates) VALUES (?, ?, ?, ?, ?, ?)";
    const params = row
      ? [email, sms, push, marketing, orderUpdates, userId]
      : [userId, email, sms, push, marketing, orderUpdates];

    db.run(query, params, (err2) => {
      if (err2) {
        console.error("DB error updating notifications:", err2.message);
        return res.status(500).json({ error: "Failed to update notifications", details: err2.message });
      }

      db.run("INSERT INTO user_activity (user_id, action) VALUES (?, ?)", [userId, "Updated notification preferences"], (aErr) => {
        if (aErr) console.error("Failed to log activity (notifications):", aErr.message);
        res.json({ success: true });
      });
    });
  });
});

// ---------- Sign out session ----------
// Wait for both delete and activity insert before responding
router.post("/signout-session", auth, (req, res) => {
  const userId = req.user?.id;
  const { sessionId } = req.body;
  if (!userId) return res.status(401).json({ error: "Missing user id in token" });
  if (!sessionId) return res.status(400).json({ error: "Session ID required" });

  db.run("DELETE FROM user_sessions WHERE id = ? AND user_id = ?", [sessionId, userId], function (err) {
    if (err) {
      console.error("DB error deleting session:", err.message);
      return res.status(500).json({ error: "Failed to sign out", details: err.message });
    }

    // Once deleted, insert activity and respond after activity insert completes
    db.run("INSERT INTO user_activity (user_id, action) VALUES (?, ?)", [userId, "Logged out"], (err2) => {
      if (err2) {
        console.error("Failed to log activity (logout):", err2.message);
        // Respond with success for deletion but include detail about activity logging failure
        return res.status(200).json({ success: true, message: "Session removed, but failed to log activity", details: err2.message });
      }

      return res.json({ success: true, message: "Logged out successfully" });
    });
  });
});

// ---------- Export account data ----------
router.get("/export", auth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Missing user id in token" });

  db.serialize(() => {
    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
      if (err) {
        console.error("DB error (users):", err.message);
        return res.status(500).json({ error: "Failed to fetch user", details: err.message });
      }
      if (!user) return res.status(404).json({ error: "User not found" });

      db.get("SELECT two_fa_enabled, backup_codes FROM user_security WHERE user_id = ?", [userId], (err2, security) => {
        if (err2) {
          console.error("DB error (user_security):", err2.message);
          return res.status(500).json({ error: "Failed to fetch security", details: err2.message });
        }

        db.get("SELECT * FROM user_notifications WHERE user_id = ?", [userId], (err3, notifications) => {
          if (err3) {
            console.error("DB error (user_notifications):", err3.message);
            return res.status(500).json({ error: "Failed to fetch notifications", details: err3.message });
          }

          db.all("SELECT * FROM user_sessions WHERE user_id = ?", [userId], (err4, sessions) => {
            if (err4) {
              console.error("DB error (user_sessions):", err4.message);
              return res.status(500).json({ error: "Failed to fetch sessions", details: err4.message });
            }

            db.all("SELECT id, action, created_at AS 'created_at' FROM user_activity WHERE user_id = ? ORDER BY created_at DESC", [userId], (err5, activity) => {
              if (err5) {
                console.error("DB error (user_activity):", err5.message);
                return res.status(500).json({ error: "Failed to fetch activity", details: err5.message });
              }

              res.json({ user, security, notifications, sessions, activity });
            });
          });
        });
      });
    });
  });
});

// ---------- Delete account ----------
router.delete("/delete", auth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Missing user id in token" });

  db.serialize(() => {
    // Remove dependent data explicitly (good for deployments where foreign keys not enforced)
    db.run("DELETE FROM user_activity WHERE user_id = ?", [userId]);
    db.run("DELETE FROM user_sessions WHERE user_id = ?", [userId]);
    db.run("DELETE FROM user_notifications WHERE user_id = ?", [userId]);
    db.run("DELETE FROM user_security WHERE user_id = ?", [userId]);

    db.run("DELETE FROM users WHERE id = ?", [userId], function (err) {
      if (err) {
        console.error("DB error deleting user:", err.message);
        return res.status(500).json({ error: "Failed to delete account", details: err.message });
      }
      res.json({ success: true, message: "Account deleted" });
    });
  });
});

export default router;
