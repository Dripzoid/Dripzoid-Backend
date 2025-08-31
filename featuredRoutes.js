// routes/featuredRoutes.js
import express from "express";
import db from "../db.js"; // sqlite3 db instance

const router = express.Router();

/**
 * GET /api/products
 * Optional query: ?featured=true
 */
router.get("/products", (req, res) => {
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

export default router;
