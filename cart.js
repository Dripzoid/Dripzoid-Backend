// routes/cartRoutes.js
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
 * Helper: Map images to selected color based on product colors order
 * Assumes:
 *   - colors = array of colors in product
 *   - images = array of image URLs in order
 * Logic: divide images equally among colors, pick images for selectedColor
 */
function getImagesForColor(images, colors = [], selectedColor) {
  if (!images || images.length === 0 || !colors || colors.length === 0) return [];

  const imagesPerColor = Math.floor(images.length / colors.length) || 1;
  const colorIndex = colors.findIndex((c) => c.toLowerCase() === (selectedColor?.toLowerCase() || ""));
  if (colorIndex === -1) return images.slice(0, imagesPerColor); // fallback: first color

  const start = colorIndex * imagesPerColor;
  const end = start + imagesPerColor;
  return images.slice(start, end);
}

/**
 * GET /api/cart
 */
router.get("/", authenticateToken, (req, res) => {
  const sql = `
    SELECT 
      cart_items.id AS cart_id,
      cart_items.product_id,
      cart_items.quantity, 
      cart_items.size AS selectedSize,
      cart_items.color AS selectedColor,
      products.name, 
      products.price, 
      products.images,
      products.colors,
      products.stock
    FROM cart_items
    JOIN products ON cart_items.product_id = products.id
    WHERE cart_items.user_id = ?
  `;

  db.all(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const mapped = rows.map((row) => {
      let images = [];
      try {
        images = typeof row.images === "string" ? JSON.parse(row.images) : row.images;
      } catch (e) {
        images = [];
      }

      let colors = [];
      try {
        colors = typeof row.colors === "string" ? JSON.parse(row.colors) : row.colors;
      } catch (e) {
        colors = [];
      }

      const filteredImages = getImagesForColor(images, colors, row.selectedColor);

      return {
        cart_id: row.cart_id,
        product_id: row.product_id,
        quantity: row.quantity,
        selectedSize: row.selectedSize,
        selectedColor: row.selectedColor,
        name: row.name,
        price: row.price,
        images: filteredImages,
        stock: row.stock,
      };
    });

    res.json(mapped);
  });
});

/**
 * POST /api/cart
 */
router.post("/", authenticateToken, (req, res) => {
  const { product_id, quantity = 1, selectedSize = null, selectedColor = null } = req.body;

  if (!product_id) return res.status(400).json({ error: "Missing product_id" });

  db.get(`SELECT id FROM products WHERE id = ?`, [product_id], (err, productRow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!productRow) return res.status(400).json({ error: `Product not found: ${product_id}` });

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
