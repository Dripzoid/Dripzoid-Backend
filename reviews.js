import express from "express";
import db from "./db.js";

const router = express.Router();

// Helper → Get IST timestamp in ISO format
function getISTDateTime() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // +05:30 in ms
  return new Date(now.getTime() + istOffset)
    .toISOString()
    .replace("Z", "+05:30"); // e.g. 2025-08-26T23:45:12.345+05:30
}

// Get all reviews for a product
router.get("/product/:productId", (req, res) => {
  const { productId } = req.params;

  const query = `
    SELECT r.id, r.productId, r.userId, r.rating, r.text, r.imageUrl, r.createdAt,
           u.name as userName
    FROM reviews r
    JOIN users u ON r.userId = u.id
    WHERE r.productId = ?
    ORDER BY r.createdAt DESC;
  `;

  db.all(query, [productId], (err, rows) => {
    if (err) {
      console.error("Error fetching reviews:", err);
      return res.status(500).json({ error: "Failed to fetch reviews" });
    }
    res.json(rows);
  });
});

// ✅ Get a single review by reviewId
router.get("/:id", (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT r.*,
      COALESCE(SUM(CASE WHEN v.vote='like' THEN 1 ELSE 0 END),0) as likes,
      COALESCE(SUM(CASE WHEN v.vote='dislike' THEN 1 ELSE 0 END),0) as dislikes
    FROM reviews r
    LEFT JOIN votes v ON r.id = v.entityId AND v.entityType='review'
    WHERE r.id = ?
    GROUP BY r.id
  `;

  db.get(sql, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Review not found" });
    res.json(row);
  });
});

// Add new review with IST timestamp
router.post("/", (req, res) => {
  const { productId, userId, rating, text, imageUrl } = req.body;
  const createdAt = getISTDateTime();

  const sql = `INSERT INTO reviews (productId, userId, rating, text, imageUrl, createdAt)
               VALUES (?, ?, ?, ?, ?, ?)`;

  db.run(sql, [productId, userId, rating, text, imageUrl, createdAt], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, createdAt });
  });
});

// Delete review
router.delete("/:id", (req, res) => {
  const { id } = req.params;

  const sql = `DELETE FROM reviews WHERE id = ?`;
  db.run(sql, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    if (this.changes === 0) {
      return res.status(404).json({ error: "Review not found" });
    }

    res.json({ success: true, message: "Review deleted" });
  });
});

export default router;

