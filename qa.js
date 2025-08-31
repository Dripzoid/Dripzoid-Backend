import express from "express";
import db from "./db.js";

const router = express.Router();

/**
 * Get all questions & answers for a product (with usernames and votes)
 */
router.get("/:productId", (req, res) => {
  const { productId } = req.params;

  db.all(
    `SELECT q.*, u.name as userName
     FROM questions q
     JOIN users u ON q.userId = u.id
     WHERE q.productId = ?
     ORDER BY q.createdAt DESC`,
    [productId],
    (err, questions) => {
      if (err) return res.status(500).json({ error: err.message });

      const qIds = questions.map((q) => q.id);
      if (qIds.length === 0) return res.json({ questions: [] });

      db.all(
        `SELECT a.*, 
                u.name as userName,
                (SELECT COUNT(*) FROM votes v WHERE v.entityId = a.id AND v.entityType='answer' AND v.vote='like') AS likes,
                (SELECT COUNT(*) FROM votes v WHERE v.entityId = a.id AND v.entityType='answer' AND v.vote='dislike') AS dislikes
         FROM answers a
         JOIN users u ON a.userId = u.id
         WHERE a.questionId IN (${qIds.map(() => "?").join(",")})
         ORDER BY a.createdAt ASC`,
        qIds,
        (err2, answers) => {
          if (err2) return res.status(500).json({ error: err2.message });

          const grouped = questions.map((q) => ({
            ...q,
            answers: answers.filter((a) => a.questionId === q.id),
          }));

          res.json({ questions: grouped });
        }
      );
    }
  );
});

/**
 * Ask a question
 */
router.post("/", (req, res) => {
  const { productId, userId, text } = req.body;
  const createdAt = new Date().toISOString();

  db.run(
    `INSERT INTO questions (productId, userId, text, createdAt) VALUES (?, ?, ?, ?)`,
    [productId, userId, text, createdAt],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({
        id: this.lastID,
        productId,
        userId,
        text,
        createdAt,
      });
    }
  );
});

/**
 * Answer a question
 */
router.post("/:questionId/answer", (req, res) => {
  const { questionId } = req.params;
  const { userId, text } = req.body;
  const createdAt = new Date().toISOString();

  db.run(
    `INSERT INTO answers (questionId, userId, text, createdAt) VALUES (?, ?, ?, ?)`,
    [questionId, userId, text, createdAt],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({
        id: this.lastID,
        questionId,
        userId,
        text,
        createdAt,
      });
    }
  );
});

export default router;

