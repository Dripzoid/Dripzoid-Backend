import express from "express";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_FILE || path.join(__dirname, "./dripzoid.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ Failed to connect to database:", err.message);
  else console.log("✅ Connected to SQLite at:", dbPath);
});

// JWT auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) return res.sendStatus(401);

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET || "Dripzoid.App@2025", (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

/**
 * GET /api/cart
 * Returns cart items with product details
 */
router.get("/", authenticateToken, (req, res) => {
  const sql = `
    SELECT 
      c.id AS cart_id,
      c.product_id,
      c.quantity,
      c.size AS selectedSize,
      c.color AS selectedColor,
      p.name,
      p.price,
      p.images,
      p.stock
    FROM cart_items c
    JOIN products p ON c.product_id = p.id
    WHERE c.user_id = ?
  `;

  db.all(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Parse images JSON if stored as string
    const normalized = rows.map((row) => {
      let images = [];
      try {
        images = typeof row.images === "string" ? JSON.parse(row.images) : row.images;
      } catch {
        images = [];
      }

      // Filter images for selected color
      if (row.selectedColor) {
        images = images.filter((img) => img.color === row.selectedColor)?.map((i) => i.url) || [];
      }

      return { ...row, images };
    });

    res.json(normalized);
  });
});

/**
 * POST /api/cart
 * Add item to cart
 */
router.post("/", authenticateToken, (req, res) => {
  const { product_id, quantity = 1, selectedSize = null, selectedColor = null } = req.body;

  if (!product_id) return res.status(400).json({ error: "Missing product_id" });
  const qty = Number(quantity) || 1;

  // Check product exists
  db.get(`SELECT id, name, price, images, stock FROM products WHERE id = ?`, [product_id], (err, productRow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!productRow) return res.status(404).json({ error: `Product not found: ${product_id}` });

    db.run(
      `INSERT INTO cart_items (user_id, product_id, size, color, quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, product_id, selectedSize, selectedColor, qty],
      function (insertErr) {
        if (insertErr) return res.status(500).json({ error: insertErr.message });

        // Return full item with product details
        const images = (() => {
          try {
            const imgs = typeof productRow.images === "string" ? JSON.parse(productRow.images) : productRow.images;
            return selectedColor
              ? imgs.filter((i) => i.color === selectedColor).map((i) => i.url)
              : imgs.map((i) => i.url);
          } catch {
            return [];
          }
        })();

        res.json({
          cart_id: this.lastID,
          product_id,
          quantity: qty,
          selectedSize,
          selectedColor,
          name: productRow.name,
          price: productRow.price,
          stock: productRow.stock,
          images,
        });
      }
    );
  });
});

/**
 * PUT /api/cart/:id
 * Update quantity
 */
router.put("/:id", authenticateToken, (req, res) => {
  const { quantity } = req.body;
  const qty = Math.max(1, Number(quantity) || 1);

  db.run(
    `UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?`,
    [qty, req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ updated: this.changes });
    }
  );
});

/**
 * DELETE /api/cart/:id
 */
router.delete("/:id", authenticateToken, (req, res) => {
  db.run(
    `DELETE FROM cart_items WHERE id = ? AND user_id = ?`,
    [req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: this.changes });
    }
  );
});

export default router;
