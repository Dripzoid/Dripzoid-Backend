// routes/admin/SalesAndSlides.js
import express from "express";
import { allQuery, getQuery, runQuery } from "../../db/db.js";
import { logAction } from "../../utils/auditLogger.js";

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                              🖼️ SLIDES SECTION                             */
/* -------------------------------------------------------------------------- */

// ✅ Get all active slides
router.get("/slides", async (req, res) => {
  try {
    const slides = await allQuery(
      "SELECT * FROM slides WHERE is_deleted = 0 ORDER BY order_index ASC"
    );
    res.json(slides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create slide
router.post("/slides", async (req, res) => {
  const { name, image_url, link } = req.body;
  const adminId = req.user?.id || null;

  if (!name || !image_url)
    return res.status(400).json({ error: "name and image_url are required" });

  try {
    const result = await runQuery(
      `INSERT INTO slides (name, image_url, link) VALUES (?, ?, ?)`,
      [name, image_url, link || null]
    );
    await logAction(adminId, "CREATE", "slide", result.lastID, { name, image_url });
    res.json({ id: result.lastID, name, image_url, link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update slide
router.put("/slides/:id", async (req, res) => {
  const { id } = req.params;
  const { name, image_url, link, order_index } = req.body;
  const adminId = req.user?.id || null;

  try {
    await runQuery(
      `UPDATE slides
       SET name=?, image_url=?, link=?, order_index=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [name, image_url, link, order_index, id]
    );
    await logAction(adminId, "UPDATE", "slide", id, { name, image_url, link });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Soft delete slide
router.delete("/slides/:id", async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id || null;

  try {
    await runQuery(`UPDATE slides SET is_deleted = 1 WHERE id = ?`, [id]);
    await logAction(adminId, "DELETE", "slide", id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Restore soft-deleted slide
router.patch("/slides/:id/restore", async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id || null;

  try {
    await runQuery(`UPDATE slides SET is_deleted = 0 WHERE id = ?`, [id]);
    await logAction(adminId, "RESTORE", "slide", id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                               💰 SALES SECTION                             */
/* -------------------------------------------------------------------------- */

// ✅ Get all sales
router.get("/sales", async (_, res) => {
  try {
    const sales = await allQuery(
      "SELECT * FROM sales WHERE is_deleted = 0 ORDER BY created_at DESC"
    );
    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create sale
router.post("/sales", async (req, res) => {
  const { name } = req.body;
  const adminId = req.user?.id || null;
  if (!name) return res.status(400).json({ error: "Sale name is required" });

  try {
    const result = await runQuery(`INSERT INTO sales (name) VALUES (?)`, [name]);
    await logAction(adminId, "CREATE", "sale", result.lastID, { name });
    res.json({ id: result.lastID, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Toggle enable/disable sale
router.patch("/sales/:id/toggle", async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id || null;

  try {
    const sale = await getQuery("SELECT enabled FROM sales WHERE id = ?", [id]);
    const newState = sale.enabled ? 0 : 1;
    await runQuery("UPDATE sales SET enabled=? WHERE id=?", [newState, id]);
    await logAction(adminId, newState ? "ENABLE" : "DISABLE", "sale", id);
    res.json({ id, enabled: newState });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Soft delete sale
router.delete("/sales/:id", async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id || null;

  try {
    await runQuery(`UPDATE sales SET is_deleted = 1 WHERE id = ?`, [id]);
    await logAction(adminId, "DELETE", "sale", id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Restore sale
router.patch("/sales/:id/restore", async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id || null;

  try {
    await runQuery(`UPDATE sales SET is_deleted = 0 WHERE id = ?`, [id]);
    await logAction(adminId, "RESTORE", "sale", id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                        🛍️ SALE PRODUCTS MANAGEMENT                        */
/* -------------------------------------------------------------------------- */

// ✅ Get products under a sale
router.get("/sales/:saleId/products", async (req, res) => {
  const { saleId } = req.params;
  try {
    const rows = await allQuery(
      `SELECT sp.*, p.name, p.price, p.image_url
       FROM sale_products sp
       JOIN products p ON sp.product_id = p.id
       WHERE sp.sale_id = ?
       ORDER BY sp.position ASC`,
      [saleId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Add product to sale
router.post("/sales/:saleId/products", async (req, res) => {
  const { saleId } = req.params;
  const { product_id, position } = req.body;
  const adminId = req.user?.id || null;

  try {
    const result = await runQuery(
      `INSERT OR REPLACE INTO sale_products (sale_id, product_id, position)
       VALUES (?, ?, ?)`,
      [saleId, product_id, position || 0]
    );
    await logAction(adminId, "ADD_PRODUCT", "sale", saleId, { product_id });
    res.json({ id: result.lastID, saleId, product_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Remove product from sale
router.delete("/sales/:saleId/products/:productId", async (req, res) => {
  const { saleId, productId } = req.params;
  const adminId = req.user?.id || null;

  try {
    await runQuery(
      `DELETE FROM sale_products WHERE sale_id=? AND product_id=?`,
      [saleId, productId]
    );
    await logAction(adminId, "REMOVE_PRODUCT", "sale", saleId, { productId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Reorder products within sale
router.patch("/sales/:saleId/reorder", async (req, res) => {
  const { saleId } = req.params;
  const { products } = req.body; // [{ product_id, position }]
  const adminId = req.user?.id || null;

  try {
    for (const item of products) {
      await runQuery(
        `UPDATE sale_products SET position=? WHERE sale_id=? AND product_id=?`,
        [item.position, saleId, item.product_id]
      );
    }
    await logAction(adminId, "REORDER_PRODUCTS", "sale", saleId, { products });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                               📜 AUDIT LOG                                 */
/* -------------------------------------------------------------------------- */

// ✅ Fetch recent audit logs
router.get("/audit", async (req, res) => {
  try {
    const logs = await allQuery(
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100`
    );
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
