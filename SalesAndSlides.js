// routes/SalesAndSlides.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";

import db from "./db.js"; // centralized DB connection
import authAdmin from "./authAdmin.js"; // admin auth middleware

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

// =============================
// Utility: Audit Logger
// =============================
async function logAction(admin_id, action_type, entity_type, entity_id, details = {}) {
  try {
    await db.run(
      `INSERT INTO audit_log (admin_id, action_type, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)`,
      [admin_id, action_type, entity_type, entity_id, JSON.stringify(details)]
    );
  } catch (err) {
    console.error("Audit log error:", err.message);
  }
}

// =======================================================
// PUBLIC ROUTES (no auth) — allow frontend to fetch data
// =======================================================

/**
 * GET /public/slides
 * Public: return active slides for homepage hero
 */
router.get("/public/slides", (req, res) => {
  const sql = `
    SELECT id, name, COALESCE(image_url, '') AS image_url, COALESCE(link, '') AS link, order_index
    FROM slides
    WHERE is_deleted = 0
    ORDER BY order_index ASC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("public/slides error:", err);
      return res.status(500).json({ error: "Failed to fetch slides" });
    }
    // normalize to a simple shape for frontend
    const slides = (rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      src: r.image_url || "",
      link: r.link || null,
      order_index: r.order_index ?? 0,
    }));
    res.json(slides);
  });
});

/**
 * GET /public/sales
 * Public: return enabled sales (active banners)
 */
router.get("/public/sales", (req, res) => {
  const sql = `
    SELECT id, name, COALESCE(image_url, '') AS image_url, COALESCE(subtitle, '') AS subtitle, COALESCE(enabled, 0) AS enabled
    FROM sales
    WHERE is_deleted = 0 AND enabled = 1
    ORDER BY id DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("public/sales error:", err);
      return res.status(500).json({ error: "Failed to fetch sales" });
    }
    const sales = (rows || []).map((r) => ({
      id: r.id,
      title: r.name,
      subtitle: r.subtitle || "",
      image_url: r.image_url || "",
      enabled: Boolean(r.enabled),
    }));
    res.json(sales);
  });
});

/**
 * GET /public/sales/:id/details
 * Public: return sale metadata and associated products (lightweight)
 */
router.get("/public/sales/:id/details", (req, res) => {
  const { id } = req.params;
  db.get(`SELECT id, name, COALESCE(image_url, '') AS image_url, COALESCE(enabled, 0) AS enabled FROM sales WHERE id = ? AND is_deleted = 0`, [id], (err, sale) => {
    if (err) {
      console.error("public/sales/:id/details error:", err);
      return res.status(500).json({ error: "Failed to fetch sale" });
    }
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (!sale.enabled) return res.status(404).json({ error: "Sale not available" });

    const sql = `
      SELECT p.id, p.name, p.price, p.originalPrice, p.images, p.rating
      FROM sale_products sp
      JOIN products p ON p.id = sp.product_id
      WHERE sp.sale_id = ?
      ORDER BY sp.position ASC
      LIMIT 100
    `;
    db.all(sql, [id], (err2, rows) => {
      if (err2) {
        console.error("public/sales/:id/details products error:", err2);
        return res.status(500).json({ error: "Failed to fetch sale products" });
      }

      const products = (rows || []).map((r) => {
        let images = [];
        if (r.images) {
          try {
            const parsed = JSON.parse(r.images);
            images = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            images = String(r.images).split(",").map((s) => s.trim()).filter(Boolean);
          }
        }
        return {
          id: r.id,
          name: r.name,
          price: r.price !== null ? Number(r.price) : null,
          originalPrice: r.originalPrice !== null ? Number(r.originalPrice) : null,
          rating: r.rating !== null ? Number(r.rating) : null,
          images,
        };
      });

      res.json({ sale: { id: sale.id, title: sale.name, image_url: sale.image_url }, products });
    });
  });
});

// =======================================================
// ADMIN ROUTES (require authAdmin) — unchanged behaviour
// =======================================================

// =============================
// CLOUDINARY IMAGE UPLOAD
// =============================
router.post("/admin/upload", authAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: "slides",
    });

    // remove local temp file
    fs.unlinkSync(req.file.path);

    res.json({ url: uploadResult.secure_url });
  } catch (error) {
    console.error("Cloudinary Upload Error:", error);
    res.status(500).json({ error: "Failed to upload image" });
  }
});

// =============================
// SLIDES MANAGEMENT (ADMIN)
// =============================

// GET all slides (admin)
router.get("/admin/slides", authAdmin, async (req, res) => {
  try {
    const slides = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM slides WHERE is_deleted = 0 ORDER BY order_index ASC`,
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    res.json(slides);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch slides" });
  }
});

// ADD new slide (admin)
router.post("/admin/slides", authAdmin, async (req, res) => {
  try {
    const { name, image_url, link } = req.body;
    if (!name || !image_url)
      return res.status(400).json({ error: "Name and image_url are required" });

    db.run(
      `INSERT INTO slides (name, image_url, link) VALUES (?, ?, ?)`,
      [name, image_url, link],
      async function (err) {
        if (err) return res.status(500).json({ error: err.message });
        await logAction(req.user.id, "CREATE", "slide", this.lastID, { name, image_url });
        res.json({ message: "Slide added successfully", id: this.lastID });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add slide" });
  }
});

// UPDATE slide (admin)
router.put("/admin/slides/:id", authAdmin, async (req, res) => {
  try {
    const { name, image_url, link, order_index } = req.body;
    const { id } = req.params;

    db.run(
      `UPDATE slides 
       SET name = ?, image_url = ?, link = ?, order_index = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [name, image_url, link, order_index, id],
      async function (err) {
        if (err) return res.status(500).json({ error: err.message });
        await logAction(req.user.id, "UPDATE", "slide", id, { name, image_url });
        res.json({ message: "Slide updated successfully" });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update slide" });
  }
});

// SOFT DELETE slide (admin)
router.delete("/admin/slides/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    db.run(`UPDATE slides SET is_deleted = 1 WHERE id = ?`, [id], async function (err) {
      if (err) return res.status(500).json({ error: err.message });
      await logAction(req.user.id, "DELETE", "slide", id);
      res.json({ message: "Slide deleted (soft) successfully" });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete slide" });
  }
});

// =============================
// SALES MANAGEMENT (ADMIN)
// =============================

// GET all sales (admin)
router.get("/admin/sales", authAdmin, async (req, res) => {
  try {
    db.all(`SELECT * FROM sales WHERE is_deleted = 0`, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

// CREATE sale (admin)
router.post("/admin/sales", authAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Sale name required" });

    db.run(`INSERT INTO sales (name) VALUES (?)`, [name], async function (err) {
      if (err) return res.status(500).json({ error: err.message });
      await logAction(req.user.id, "CREATE", "sale", this.lastID, { name });
      res.json({ message: "Sale created successfully", id: this.lastID });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create sale" });
  }
});

// UPDATE sale (admin)
router.put("/admin/sales/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, enabled } = req.body;

    db.run(
      `UPDATE sales 
       SET name = COALESCE(?, name), 
           enabled = COALESCE(?, enabled), 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [name, enabled, id],
      async function (err) {
        if (err) return res.status(500).json({ error: err.message });
        await logAction(req.user.id, "UPDATE", "sale", id, { name, enabled });
        res.json({ message: "Sale updated successfully" });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update sale" });
  }
});

// SOFT DELETE sale (admin)
router.delete("/admin/sales/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    db.run(`UPDATE sales SET is_deleted = 1 WHERE id = ?`, [id], async function (err) {
      if (err) return res.status(500).json({ error: err.message });
      await logAction(req.user.id, "DELETE", "sale", id);
      res.json({ message: "Sale soft-deleted successfully" });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

// =============================
// SALE PRODUCTS MANAGEMENT (ADMIN)
// =============================

// Add products to sale (admin)
router.post("/admin/sales/:sale_id/products", authAdmin, async (req, res) => {
  try {
    const { sale_id } = req.params;
    const { product_ids } = req.body;

    if (!Array.isArray(product_ids) || product_ids.length === 0)
      return res.status(400).json({ error: "No products provided" });

    const insert = db.prepare(
      `INSERT OR IGNORE INTO sale_products (sale_id, product_id, position) VALUES (?, ?, ?)`
    );

    product_ids.forEach((pid, idx) => insert.run([sale_id, pid, idx]));
    insert.finalize();

    await logAction(req.user.id, "CREATE", "sale_product", sale_id, { product_ids });
    res.json({ message: "Products added to sale successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add products" });
  }
});

// Remove product from sale (admin)
router.delete("/admin/sales/:sale_id/products/:product_id", authAdmin, async (req, res) => {
  try {
    const { sale_id, product_id } = req.params;
    db.run(
      `DELETE FROM sale_products WHERE sale_id = ? AND product_id = ?`,
      [sale_id, product_id],
      async function (err) {
        if (err) return res.status(500).json({ error: err.message });
        await logAction(req.user.id, "DELETE", "sale_product", sale_id, { product_id });
        res.json({ message: "Product removed from sale" });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to remove product" });
  }
});

// =============================
// GET Sale Details with Products (ADMIN)
// =============================
router.get("/admin/sales/:id/details", authAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    db.get(`SELECT * FROM sales WHERE id = ?`, [id], (err, sale) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!sale) return res.status(404).json({ error: "Sale not found" });

      db.all(
        `SELECT p.id, p.name, p.price, sp.position
         FROM sale_products sp
         JOIN products p ON p.id = sp.product_id
         WHERE sp.sale_id = ?
         ORDER BY sp.position ASC`,
        [id],
        (err2, products) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ sale, products });
        }
      );
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sale details" });
  }
});

export default router;
