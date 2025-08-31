// routes/wishlist.js
import express from "express";
import db from "../db.js";
import auth  from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/wishlist
 * Get all wishlist items
 */
router.get("/", auth, (req, res) => {
  const userId = req.user.id;
  const sql = `
    SELECT w.id, w.product_id, p.name, p.price, p.images, w.created_at
    FROM wishlist_items w
    JOIN products p ON w.product_id = p.id
    WHERE w.user_id = ?
    ORDER BY w.created_at DESC
  `;
  db.all(sql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

/**
 * POST /api/wishlist/move-to-cart
 * Move multiple wishlist items to cart
 */
router.post("/move-to-cart", auth, (req, res) => {
  const userId = req.user.id;
  const { productIds } = req.body; // expects [1,2,3]

  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ error: "Invalid productIds array" });
  }

  // Insert into cart (assuming you have cart_items table)
  const placeholders = productIds.map(() => "(?, ?)").join(", ");
  const values = productIds.flatMap((pid) => [userId, pid]);
  const sqlInsert = `INSERT OR IGNORE INTO cart_items (user_id, product_id) VALUES ${placeholders}`;

  db.run(sqlInsert, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });

    // Now delete from wishlist
    const placeholdersDel = productIds.map(() => "?").join(", ");
    const sqlDel = `DELETE FROM wishlist_items WHERE user_id = ? AND product_id IN (${placeholdersDel})`;
    db.run(sqlDel, [userId, ...productIds], function (err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({
        message: "Moved to cart successfully",
        addedToCart: this.changes,
      });
    });
  });
});

router.post("/bulk", auth, (req, res) => {
  const userId = req.user.id;
  const { productIds } = req.body; // expects [1,2,3]

  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ error: "Invalid productIds array" });
  }

  const placeholders = productIds.map(() => "(?, ?)").join(", ");
  const values = productIds.flatMap((pid) => [userId, pid]);

  const sql = `INSERT OR IGNORE INTO wishlist_items (user_id, product_id) VALUES ${placeholders}`;
  db.run(sql, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Bulk add successful", count: this.changes });
  });
});
/**
 * POST /api/wishlist/:productId
 * Add single product to wishlist
 */
router.post("/:productId", auth, (req, res) => {
  const userId = req.user.id;
  const { productId } = req.params;
  const sql = `INSERT OR IGNORE INTO wishlist_items (user_id, product_id) VALUES (?, ?)`;
  db.run(sql, [userId, productId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Added to wishlist", id: this.lastID });
  });
});

/**
 * POST /api/wishlist/bulk
 * Add multiple products to wishlist
 */


/**
 * DELETE /api/wishlist/bulk
 * Delete multiple products
 */
router.delete("/bulk", auth, (req, res) => {
  const userId = req.user.id;
  const { productIds } = req.body; // expects [1,2,3]

  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ error: "Invalid productIds array" });
  }

  const placeholders = productIds.map(() => "?").join(", ");
  const sql = `DELETE FROM wishlist_items WHERE user_id = ? AND product_id IN (${placeholders})`;
  db.run(sql, [userId, ...productIds], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Bulk delete successful", changes: this.changes });
  });
});
/**
 * DELETE /api/wishlist/:productId
 * Remove single product
 */
router.delete("/:productId", auth, (req, res) => {
  const userId = req.user.id;
  const { productId } = req.params;
  const sql = `DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?`;
  db.run(sql, [userId, productId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Removed", changes: this.changes });
  });
});





export default router;
