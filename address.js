// routes/address.js
import express from "express";
import db from "./db.js"; // your SQLite connection
import { auth } from "./auth.js";

const router = express.Router();

// Helper functions (promisify db.run / db.all / db.get)
const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this); // this.lastID, this.changes
    });
  });

const getQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

const allQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

// =========================
// Routes
// =========================

// 📌 Get all addresses for logged-in user
router.get("/", auth, async (req, res) => {
  try {
    const addresses = await allQuery(
      "SELECT * FROM addresses WHERE user_id = ? ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json(addresses);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch addresses", error: err.message });
  }
});

// 📌 Add new address (includes name)
router.post("/", auth, async (req, res) => {
  try {
    const {
      name,
      label,
      line1,
      line2,
      city,
      state,
      pincode,
      country,
      phone,
      is_default,
    } = req.body;

    if (!name || !line1 || !city || !state || !pincode) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // If this address is set as default, reset all others for this user
    if (is_default) {
      await runQuery("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [req.user.id]);
    }

    const result = await runQuery(
      `INSERT INTO addresses 
        (user_id, name, label, line1, line2, city, state, pincode, country, phone, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        name,
        label,
        line1,
        line2,
        city,
        state,
        pincode,
        country || "India",
        phone,
        is_default ? 1 : 0,
      ]
    );

    const newAddress = await getQuery("SELECT * FROM addresses WHERE id = ?", [result.lastID]);
    res.status(201).json(newAddress);
  } catch (err) {
    res.status(500).json({ message: "Failed to add address", error: err.message });
  }
});

// 📌 Update address (includes name)
router.put("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      label,
      line1,
      line2,
      city,
      state,
      pincode,
      country,
      phone,
      is_default,
    } = req.body;

    if (!name || !line1 || !city || !state || !pincode) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // If this is being marked as default, reset all others for this user
    if (is_default) {
      await runQuery("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [req.user.id]);
    }

    const result = await runQuery(
      `UPDATE addresses 
       SET name=?, label=?, line1=?, line2=?, city=?, state=?, pincode=?, country=?, phone=?, is_default=?
       WHERE id=? AND user_id=?`,
      [
        name,
        label,
        line1,
        line2,
        city,
        state,
        pincode,
        country || "India",
        phone,
        is_default ? 1 : 0,
        id,
        req.user.id,
      ]
    );

    if (result.changes === 0) {
      return res.status(404).json({ message: "Address not found" });
    }

    const updated = await getQuery("SELECT * FROM addresses WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to update address", error: err.message });
  }
});

// 📌 Delete address
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await runQuery(
      "DELETE FROM addresses WHERE id=? AND user_id=?",
      [id, req.user.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ message: "Address not found" });
    }

    res.json({ message: "Address deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete address", error: err.message });
  }
});

// 📌 Get default address
router.get("/default", auth, async (req, res) => {
  try {
    const defaultAddress = await getQuery(
      "SELECT * FROM addresses WHERE user_id = ? AND is_default = 1",
      [req.user.id]
    );
    res.json(defaultAddress || {});
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch default address", error: err.message });
  }
});

export default router;
