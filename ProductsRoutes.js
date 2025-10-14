// ProductsRoutes.js
import express from "express";
import db from "./db.js"; // sqlite3 db instance

const router = express.Router();

/**
 * GET /api/featured
 * Optional query: ?featured=true
 */
router.get("/featured", (req, res) => {
  const isFeatured = req.query.featured === "true"; // Convert to boolean

  let sql;
  if (isFeatured) {
    // Requires a `featured` column (INTEGER 0/1) in products table
    sql = `SELECT id, name, price, images 
           FROM products 
           WHERE featured = 1 
           ORDER BY id DESC`;
  } else {
    sql = `SELECT id, name, price, images 
           FROM products 
           ORDER BY id DESC 
           LIMIT 100`;
  }

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("DB error fetching products:", err);
      return res.status(500).json({ error: err.message });
    }

    res.json(rows || []);
  });
});

/**
 * GET /api/trending
 * Fetch top 10 sold products
 */
router.get("/trending", (req, res) => {
  const sql = `SELECT id, name, price, images, sold 
               FROM products 
               ORDER BY sold DESC 
               LIMIT 10`;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("DB error fetching trending products:", err);
      return res.status(500).json({ error: err.message });
    }

    res.json(rows || []);
  });
});

export default router;
