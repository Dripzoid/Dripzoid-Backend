// routes/SalesAndSlides.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";

import db from "./db.js"; // centralized sqlite3 connection instance
import authAdmin from "./authAdmin.js"; // admin auth middleware

dotenv.config();
const router = express.Router();

/* ---------- Cloudinary ---------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ---------- Multer ---------- */
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

/* ---------- SQLite helpers ---------- */
const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    })
  );

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))
  );

const execAsync = (sql) =>
  new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve())));

/* ---------- Audit logger ---------- */
async function logAction(admin_id, action_type, entity_type, entity_id, details = {}) {
  try {
    await runAsync(
      `INSERT INTO audit_log (admin_id, action_type, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)`,
      [admin_id, action_type, entity_type, entity_id, JSON.stringify(details)]
    );
  } catch (e) {
    console.error("audit log error:", e?.message || e);
  }
}

/* ---------- Helpers ---------- */
function safeParseImages(imagesField) {
  if (!imagesField) return [];
  if (Array.isArray(imagesField)) return imagesField;
  try {
    const parsed = JSON.parse(imagesField);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "string") return parsed.split(",").map((p) => p.trim()).filter(Boolean);
    return [parsed];
  } catch {
    // fallback: comma separated
    return String(imagesField).split(",").map((p) => p.trim()).filter(Boolean);
  }
}

/* ======================================================
   PUBLIC ROUTES (mounted under /api if your app uses /api)
   GET /public/sales  -> for homepage "On Sale" section
====================================================== */
router.get("/public/sales", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || "10", 10)));
    const productsPerSale = Math.max(1, Math.min(50, parseInt(req.query.productsPerSale || "12", 10)));

    const sales = await allAsync(
      `SELECT id, name
       FROM sales
       WHERE is_deleted = 0 AND enabled = 1
       ORDER BY id DESC
       LIMIT ?`,
      [limit]
    );

    const enriched = await Promise.all(
      sales.map(async (s) => {
        const prods = await allAsync(
          `SELECT p.id, p.name, p.price, p.originalPrice, p.images
           FROM sale_products sp
           JOIN products p ON p.id = sp.product_id
           WHERE sp.sale_id = ?
           ORDER BY sp.position ASC
           LIMIT ?`,
          [s.id, productsPerSale]
        );

        const products = (prods || []).map((p) => {
          const images = safeParseImages(p.images);
          return {
            id: p.id,
            name: p.name,
            price: p.price !== null ? Number(p.price) : null,
            originalPrice: p.originalPrice !== null ? Number(p.originalPrice) : null,
            images,
            thumbnail: images[0] || null,
          };
        });

        return {
          id: s.id,
          title: s.name,
          productCount: products.length,
          products,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error("/public/sales error:", err);
    res.status(500).json({ error: "Failed to fetch public sales" });
  }
});

/* ======================================================
   OTHER PUBLIC ROUTES (slides, sale details)
====================================================== */
router.get("/public/slides", async (req, res) => {
  try {
    const rows = await allAsync(
      `SELECT id, name, COALESCE(image_url,'') AS image_url, COALESCE(link,'') AS link, order_index
       FROM slides WHERE is_deleted = 0 ORDER BY order_index ASC`
    );
    const slides = (rows || []).map((r) => ({ id: r.id, name: r.name, src: r.image_url || "", link: r.link || null, order_index: r.order_index || 0 }));
    res.json(slides);
  } catch (err) {
    console.error("/public/slides error:", err);
    res.status(500).json({ error: "Failed to fetch slides" });
  }
});

router.get("/public/sales/:id/details", async (req, res) => {
  try {
    const id = req.params.id;

    const sale = await getAsync(
      `SELECT id, name
       FROM sales
       WHERE id = ? AND is_deleted = 0 AND enabled = 1`,
      [id]
    );

    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const products = await allAsync(
      `SELECT p.id, p.name, p.price, p.originalPrice, p.images, p.rating
       FROM sale_products sp
       JOIN products p ON p.id = sp.product_id
       WHERE sp.sale_id = ?
       ORDER BY sp.position ASC`,
      [id]
    );

    const mapped = (products || []).map((p) => {
      const images = safeParseImages(p.images);
      return {
        id: p.id,
        name: p.name,
        price: p.price !== null ? Number(p.price) : null,
        originalPrice: p.originalPrice !== null ? Number(p.originalPrice) : null,
        rating: p.rating !== null ? Number(p.rating) : null,
        images,
        thumbnail: images[0] || null,
      };
    });

    res.json({
      sale: {
        id: sale.id,
        title: sale.name,
      },
      products: mapped,
    });
  } catch (err) {
    console.error("sale details error:", err);
    res.status(500).json({ error: "Failed to fetch sale details" });
  }
});

/* ======================================================
   ADMIN ROUTES (authAdmin)
====================================================== */

/* Upload */
router.post("/admin/upload", authAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const uploadResult = await cloudinary.uploader.upload(req.file.path, { folder: "slides" });
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ url: uploadResult.secure_url });
  } catch (err) {
    console.error("/admin/upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* Slides admin (unchanged behavior but using async helpers) */
router.get("/admin/slides", authAdmin, async (req, res) => {
  try {
    const slides = await allAsync(`SELECT * FROM slides WHERE is_deleted = 0 ORDER BY order_index ASC`);
    res.json(slides);
  } catch (err) {
    console.error("admin/slides error:", err);
    res.status(500).json({ error: "Failed to fetch slides" });
  }
});

router.post("/admin/slides", authAdmin, async (req, res) => {
  try {
    const { name, image_url, link } = req.body;
    if (!name || !image_url) return res.status(400).json({ error: "Name and image_url required" });
    const result = await runAsync(`INSERT INTO slides (name, image_url, link) VALUES (?, ?, ?)`, [name, image_url, link]);
    await logAction(req.user.id, "CREATE", "slide", result.lastID, { name });
    res.json({ message: "Slide added", id: result.lastID });
  } catch (err) {
    console.error("admin/post slide error:", err);
    res.status(500).json({ error: "Failed to add slide" });
  }
});

router.put("/admin/slides/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, image_url, link, order_index } = req.body;
    await runAsync(`UPDATE slides SET name = ?, image_url = ?, link = ?, order_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [name, image_url, link, order_index, id]);
    await logAction(req.user.id, "UPDATE", "slide", id, { name });
    res.json({ message: "Slide updated" });
  } catch (err) {
    console.error("admin/put slide error:", err);
    res.status(500).json({ error: "Failed to update slide" });
  }
});

router.delete("/admin/slides/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await runAsync(`UPDATE slides SET is_deleted = 1 WHERE id = ?`, [id]);
    await logAction(req.user.id, "DELETE", "slide", id, {});
    res.json({ message: "Slide soft-deleted" });
  } catch (err) {
    console.error("admin/delete slide error:", err);
    res.status(500).json({ error: "Failed to delete slide" });
  }
});

/* ---------- Sales admin ---------- */

/**
 * Admin: fetch sales (includes productIds)
 */
router.get("/admin/sales", authAdmin, async (req, res) => {
  try {
    const sales = await allAsync(`SELECT * FROM sales WHERE is_deleted = 0 ORDER BY id DESC`);
    const enriched = await Promise.all(sales.map(async (s) => {
      const rows = await allAsync(`SELECT product_id FROM sale_products WHERE sale_id = ? ORDER BY position ASC`, [s.id]);
      return { ...s, productIds: rows.map(r => r.product_id) };
    }));
    res.json(enriched);
  } catch (err) {
    console.error("admin/get sales error:", err);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

/**
 * Admin: create sale (optionally with productIds array)
 * Accepts productIds OR product_ids (array)
 */
router.post("/admin/sales", authAdmin, async (req, res) => {
  const name = req.body?.name;
  const incoming = Array.isArray(req.body.productIds) ? req.body.productIds : Array.isArray(req.body.product_ids) ? req.body.product_ids : [];

  if (!name) return res.status(400).json({ error: "Sale name required" });

  // normalize ids (keep as-is if not numeric)
  const productIds = (incoming || []).map(pid => (typeof pid === "string" && /^\d+$/.test(pid) ? Number(pid) : pid));

  try {
    await execAsync("BEGIN TRANSACTION;");

    const { lastID } = await runAsync(`INSERT INTO sales (name) VALUES (?)`, [name]);
    const saleId = lastID;

    if (productIds.length > 0) {
      const stmt = db.prepare(`INSERT OR IGNORE INTO sale_products (sale_id, product_id, position) VALUES (?, ?, ?)`);

      productIds.forEach((pid, idx) => stmt.run([saleId, pid, idx]));

      await new Promise((resolve, reject) => stmt.finalize((err) => (err ? reject(err) : resolve())));
    }

    await execAsync("COMMIT;");

    await logAction(req.user.id, "CREATE", "sale", saleId, { name, productIds });

    // return created sale and basic product rows (best-effort)
    let products = [];
    try {
      if (productIds.length) {
        const placeholders = productIds.map(() => "?").join(",");
        products = await allAsync(`SELECT id, name, price, images FROM products WHERE id IN (${placeholders})`, productIds);
        products = (products || []).map(p => {
          const images = safeParseImages(p.images);
          return { id: p.id, name: p.name, price: p.price !== null ? Number(p.price) : null, images, thumbnail: images[0] || null };
        });
      }
    } catch (fetchErr) {
      console.warn("Could not fetch product rows after creation:", fetchErr);
    }

    res.json({ message: "Sale created", sale: { id: saleId, name, productIds }, products });
  } catch (err) {
    try { await execAsync("ROLLBACK;"); } catch (e) {}
    console.error("admin/create sale error:", err);
    res.status(500).json({ error: "Failed to create sale" });
  }
});

/* update, soft delete */
router.put("/admin/sales/:id", authAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { name, enabled } = req.body;
    await runAsync(`UPDATE sales SET name = COALESCE(?, name), enabled = COALESCE(?, enabled), updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [name, enabled, id]);
    await logAction(req.user.id, "UPDATE", "sale", id, { name, enabled });
    res.json({ message: "Sale updated" });
  } catch (err) {
    console.error("admin/put sale error:", err);
    res.status(500).json({ error: "Failed to update sale" });
  }
});

router.delete("/admin/sales/:id", authAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await runAsync(`UPDATE sales SET is_deleted = 1 WHERE id = ?`, [id]);
    await logAction(req.user.id, "DELETE", "sale", id);
    res.json({ message: "Sale soft-deleted" });
  } catch (err) {
    console.error("admin/delete sale error:", err);
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

/* Add products to sale (admin) */
router.post("/admin/sales/:sale_id/products", authAdmin, async (req, res) => {
  try {
    const saleId = req.params.sale_id;
    const incoming = Array.isArray(req.body.productIds) ? req.body.productIds : Array.isArray(req.body.product_ids) ? req.body.product_ids : [];
    if (!incoming.length) return res.status(400).json({ error: "No products provided" });
    const productIds = incoming.map(pid => (typeof pid === "string" && /^\d+$/.test(pid) ? Number(pid) : pid));

    await execAsync("BEGIN;");

    const stmt = db.prepare(`INSERT OR IGNORE INTO sale_products (sale_id, product_id, position) VALUES (?, ?, ?)`);

    productIds.forEach((pid, idx) => stmt.run([saleId, pid, idx]));

    await new Promise((resolve, reject) => stmt.finalize((err) => (err ? reject(err) : resolve())));

    await execAsync("COMMIT;");

    await logAction(req.user.id, "CREATE", "sale_product", saleId, { productIds });

    res.json({ message: "Products added", productIds });
  } catch (err) {
    try { await execAsync("ROLLBACK;"); } catch (e) {}
    console.error("admin/add sale products error:", err);
    res.status(500).json({ error: "Failed to add products to sale" });
  }
});

/* remove product from sale */
router.delete("/admin/sales/:sale_id/products/:product_id", authAdmin, async (req, res) => {
  try {
    const { sale_id, product_id } = req.params;
    await runAsync(`DELETE FROM sale_products WHERE sale_id = ? AND product_id = ?`, [sale_id, product_id]);
    await logAction(req.user.id, "DELETE", "sale_product", sale_id, { product_id });
    res.json({ message: "Product removed from sale" });
  } catch (err) {
    console.error("admin/delete sale product error:", err);
    res.status(500).json({ error: "Failed to remove product" });
  }
});

/* admin sale details */
router.get("/admin/sales/:id/details", authAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const sale = await getAsync(`SELECT * FROM sales WHERE id = ?`, [id]);
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const products = await allAsync(
      `SELECT p.id, p.name, p.price, sp.position FROM sale_products sp JOIN products p ON p.id = sp.product_id WHERE sp.sale_id = ? ORDER BY sp.position ASC`,
      [id]
    );

    res.json({ sale, products });
  } catch (err) {
    console.error("admin/sale details error:", err);
    res.status(500).json({ error: "Failed to fetch sale details" });
  }
});

export default router;
