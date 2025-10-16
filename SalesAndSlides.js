// routes/SalesAndSlides.js
import express from "express";
import multer from "multer";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import fs from "fs";
import authAdmin from "./authAdmin.js"; // ✅ Admin auth middleware
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";

dotenv.config();

const router = express.Router();

// =============================
// Cloudinary Config
// =============================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// =============================
// SQLite Connection
// =============================
let db;
(async () => {
  db = await open({
    filename: path.join(process.cwd(), "database.sqlite"),
    driver: sqlite3.Database,
  });
})();

// =============================
// Multer Setup (for image uploads)
// =============================
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  },
});
const upload = multer({ storage });

// Utility: Audit Logger
async function logAction(admin_id, action_type, entity_type, entity_id, details = {}) {
  await db.run(
    `INSERT INTO audit_log (admin_id, action_type, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)`,
    [admin_id, action_type, entity_type, entity_id, JSON.stringify(details)]
  );
}

// =============================
// CLOUDINARY IMAGE UPLOAD
// =============================
router.post("/upload", authAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: "slides",
    });

    // remove local file
    fs.unlinkSync(req.file.path);

    res.json({ url: uploadResult.secure_url });
  } catch (error) {
    console.error("Cloudinary Upload Error:", error);
    res.status(500).json({ error: "Failed to upload image" });
  }
});

// =============================
// SLIDES MANAGEMENT
// =============================

// GET all slides
router.get("/slides", authAdmin, async (req, res) => {
  const slides = await db.all(
    `SELECT * FROM slides WHERE is_deleted = 0 ORDER BY order_index ASC`
  );
  res.json(slides);
});

// ADD new slide
router.post("/slides", authAdmin, async (req, res) => {
  try {
    const { name, image_url, link } = req.body;
    if (!name || !image_url)
      return res.status(400).json({ error: "Name and image_url are required" });

    const { lastID } = await db.run(
      `INSERT INTO slides (name, image_url, link) VALUES (?, ?, ?)`,
      [name, image_url, link]
    );

    await logAction(req.user.id, "CREATE", "slide", lastID, { name, image_url });
    res.json({ message: "Slide added successfully", id: lastID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add slide" });
  }
});

// UPDATE slide
router.put("/slides/:id", authAdmin, async (req, res) => {
  try {
    const { name, image_url, link, order_index } = req.body;
    const { id } = req.params;

    await db.run(
      `UPDATE slides SET name = ?, image_url = ?, link = ?, order_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name, image_url, link, order_index, id]
    );

    await logAction(req.user.id, "UPDATE", "slide", id, { name, image_url });
    res.json({ message: "Slide updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update slide" });
  }
});

// SOFT DELETE slide
router.delete("/slides/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.run(`UPDATE slides SET is_deleted = 1 WHERE id = ?`, [id]);
    await logAction(req.user.id, "DELETE", "slide", id);
    res.json({ message: "Slide deleted (soft) successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete slide" });
  }
});

// =============================
// SALES MANAGEMENT
// =============================

// GET all sales
router.get("/sales", authAdmin, async (req, res) => {
  const sales = await db.all(`SELECT * FROM sales WHERE is_deleted = 0`);
  res.json(sales);
});

// CREATE sale
router.post("/sales", authAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Sale name required" });

    const { lastID } = await db.run(`INSERT INTO sales (name) VALUES (?)`, [name]);
    await logAction(req.user.id, "CREATE", "sale", lastID, { name });
    res.json({ message: "Sale created successfully", id: lastID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create sale" });
  }
});

// UPDATE sale (enable/disable or rename)
router.put("/sales/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, enabled } = req.body;

    await db.run(
      `UPDATE sales SET name = COALESCE(?, name), enabled = COALESCE(?, enabled), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [name, enabled, id]
    );

    await logAction(req.user.id, "UPDATE", "sale", id, { name, enabled });
    res.json({ message: "Sale updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update sale" });
  }
});

// SOFT DELETE sale
router.delete("/sales/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.run(`UPDATE sales SET is_deleted = 1 WHERE id = ?`, [id]);
    await logAction(req.user.id, "DELETE", "sale", id);
    res.json({ message: "Sale soft-deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

// =============================
// SALE PRODUCTS MANAGEMENT
// =============================

// Add product(s) to sale
router.post("/sales/:sale_id/products", authAdmin, async (req, res) => {
  try {
    const { sale_id } = req.params;
    const { product_ids } = req.body;

    if (!Array.isArray(product_ids) || product_ids.length === 0)
      return res.status(400).json({ error: "No products provided" });

    const insertPromises = product_ids.map((pid, idx) =>
      db.run(
        `INSERT OR IGNORE INTO sale_products (sale_id, product_id, position) VALUES (?, ?, ?)`,
        [sale_id, pid, idx]
      )
    );

    await Promise.all(insertPromises);
    await logAction(req.user.id, "CREATE", "sale_product", sale_id, { product_ids });
    res.json({ message: "Products added to sale successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add products" });
  }
});

// Remove product from sale
router.delete("/sales/:sale_id/products/:product_id", authAdmin, async (req, res) => {
  try {
    const { sale_id, product_id } = req.params;
    await db.run(`DELETE FROM sale_products WHERE sale_id = ? AND product_id = ?`, [
      sale_id,
      product_id,
    ]);
    await logAction(req.user.id, "DELETE", "sale_product", sale_id, { product_id });
    res.json({ message: "Product removed from sale" });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove product" });
  }
});

// =============================
// GET Sale Details with Products
// =============================
router.get("/sales/:id/details", authAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const sale = await db.get(`SELECT * FROM sales WHERE id = ?`, [id]);
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const products = await db.all(
      `SELECT p.id, p.name, p.price, sp.position
       FROM sale_products sp
       JOIN products p ON p.id = sp.product_id
       WHERE sp.sale_id = ?
       ORDER BY sp.position ASC`,
      [id]
    );

    res.json({ sale, products });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sale details" });
  }
});

export default router;
