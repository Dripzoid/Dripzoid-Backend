// routes/cartRoutes.js
import express from "express";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new sqlite3.Database(path.join(__dirname, "./dripzoid.db"));

// Middleware: JWT authentication
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) return res.sendStatus(401);

  const token = authHeader.split(" ")[1];
  jwt.verify(token, "Dripzoid.App@2025", (err, user) => {
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
      cart_items.id AS cart_id,
      cart_items.product_id,
      cart_items.quantity, 
      cart_items.size AS selectedSize,     -- ✅ renamed
      cart_items.color AS selectedColor,   -- ✅ renamed
      products.name, 
      products.price, 
      products.images,
      products.stock
    FROM cart_items
    JOIN products ON cart_items.product_id = products.id
    WHERE cart_items.user_id = ?
  `;

  db.all(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

/**
 * POST /api/cart
 * Adds an item to the cart — validates product exists first
 */
router.post("/", authenticateToken, (req, res) => {
  const {
    product_id,
    quantity = 1,
    selectedSize = null,
    selectedColor = null,
  } = req.body;

  if (!product_id) {
    return res.status(400).json({ error: "Missing product_id" });
  }

  // Check product exists
  db.get(`SELECT id FROM products WHERE id = ?`, [product_id], (err, productRow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!productRow) {
      return res.status(400).json({ error: `Product not found: ${product_id}` });
    }

    db.run(
      `INSERT INTO cart_items (user_id, product_id, size, color, quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, product_id, selectedSize, selectedColor, quantity],
      function (insertErr) {
        if (insertErr) return res.status(500).json({ error: insertErr.message });
        res.json({ id: this.lastID });
      }
    );
  });
});

/**
 * PUT /api/cart/:id
 * Updates quantity for a cart item
 */
router.put("/:id", authenticateToken, (req, res) => {
  const { quantity } = req.body;
  db.run(
    `UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?`,
    [quantity, req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ updated: this.changes });
    }
  );
});

/**
 * DELETE /api/cart/:id
 * Removes a cart item
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
