import express from "express";
import db from "./db.js";

const router = express.Router();

// Handle votes (same as before)
router.post("/", (req, res) => {
  const { entityId, entityType, userId, vote } = req.body;

  const checkSql = `SELECT * FROM votes WHERE entityId=? AND entityType=? AND userId=?`;
  db.get(checkSql, [entityId, entityType, userId], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });

    if (!existing && vote !== "none") {
      const insertSql = `INSERT INTO votes (entityId, entityType, userId, vote) VALUES (?, ?, ?, ?)`;
      db.run(insertSql, [entityId, entityType, userId, vote], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, action: "inserted" });
      });
    } else if (existing && vote === "none") {
      const deleteSql = `DELETE FROM votes WHERE id=?`;
      db.run(deleteSql, [existing.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, action: "removed" });
      });
    } else if (existing && existing.vote !== vote) {
      const updateSql = `UPDATE votes SET vote=? WHERE id=?`;
      db.run(updateSql, [vote, existing.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, action: "updated" });
      });
    } else {
      res.json({ success: true, action: "noop" });
    }
  });
});

// ✅ New GET votes route using query params
router.get("/", (req, res) => {
  const { entityType, entityIds } = req.query;

  if (!entityType || !entityIds) {
    return res.status(400).json({ error: "entityType and entityIds are required" });
  }

  const ids = entityIds.split(",").map((id) => id.trim());

  const placeholders = ids.map(() => "?").join(",");
  const sql = `
    SELECT entityId, vote, COUNT(*) as count
    FROM votes
    WHERE entityType=? AND entityId IN (${placeholders})
    GROUP BY entityId, vote
  `;

  db.all(sql, [entityType, ...ids], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Format response as { 11: { like: X, dislike: Y }, 9: { like: A, dislike: B } }
    const result = {};
    rows.forEach((row) => {
      if (!result[row.entityId]) result[row.entityId] = {};
      result[row.entityId][row.vote] = row.count;
    });

    res.json({ success: true, votes: result });
  });
});

export default router;

