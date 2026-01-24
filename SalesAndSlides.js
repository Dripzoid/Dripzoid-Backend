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

// ---------------------------------
// Promise wrappers for sqlite3 API
// ---------------------------------
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      // return lastID and changes for callers
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// helper: start/commit/rollback transaction
function execAsync(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
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
// ADMIN ROUTES (require authAdmin)
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

// GET all sales (admin) -- now includes productIds array per sale
router.get("/admin/sales", authAdmin, async (req, res) => {
  try {
    const sales = await allAsync(`SELECT * FROM sales WHERE is_deleted = 0 ORDER BY id DESC`);
    // for each sale, fetch product ids
    const salesWithProducts = await Promise.all(
      sales.map(async (s) => {
        const rows = await allAsync(`SELECT product_id FROM sale_products WHERE sale_id = ? ORDER BY position ASC`, [s.id]);
        const productIds = (rows || []).map((r) => r.product_id);
        return { ...s, productIds };
      })
    );
    res.json(salesWithProducts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

// Helper: insert sale and attach products in a transaction
async function insertSaleWithProducts({ name, productIds = [] }, adminId) {
  // normalize ids to numbers/strings consistent with DB
  const normalized = Array.isArray(productIds) ? productIds.map((id) => (typeof id === "string" && id.match(/^\d+$/) ? Number(id) : id)) : [];

  try {
    // BEGIN TRANSACTION
    await execAsync("BEGIN TRANSACTION;");

    // insert sale
    const { lastID } = await runAsync(`INSERT INTO sales (name) VALUES (?)`, [name]);
    const saleId = lastID;

    // prepare statement for inserting sale_products
    const stmt = db.prepare(`INSERT OR IGNORE INTO sale_products (sale_id, product_id, position) VALUES (?, ?, ?)`);

    // wrap prepare-run-finalize into promises to ensure proper ordering
    await new Promise((resolve, reject) => {
      normalized.forEach((pid, idx) => {
        stmt.run([saleId, pid, idx], (err) => {
          if (err) {
            // don't reject here immediately because stmt.run called multiple times; capture error and finalize after
            // but simpler: we record and handle after
          }
        });
      });
      stmt.finalize((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // COMMIT
    await execAsync("COMMIT;");

    // audit
    await logAction(adminId, "CREATE", "sale", saleId, { name, productIds: normalized });

    // return created sale id and productIds
    return { id: saleId, name, productIds: normalized };
  } catch (err) {
    console.error("insertSaleWithProducts error:", err);
    try {
      await execAsync("ROLLBACK;");
    } catch (rollbackErr) {
      console.error("rollback error:", rollbackErr);
    }
    throw err;
  }
}

// CREATE sale (admin)
// Supports optional productIds (or product_ids) in request body; if present, will add sale_products rows.
router.post("/admin/sales", authAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    // accept both productIds (camelCase from frontend) and product_ids (snake_case)
    const incomingProductIds = Array.isArray(req.body.productIds)
      ? req.body.productIds
      : Array.isArray(req.body.product_ids)
      ? req.body.product_ids
      : [];

    if (!name) return res.status(400).json({ error: "Sale name required" });

    // If productIds provided, insert sale and sale_products in transaction
    if (incomingProductIds && incomingProductIds.length > 0) {
      try {
        const created = await insertSaleWithProducts({ name, productIds: incomingProductIds }, req.user.id);

        // fetch product objects for response (non-blocking failure shouldn't break creation)
        let products = [];
        try {
          if (created.productIds.length > 0) {
            // build placeholders
            const placeholders = created.productIds.map(() => "?").join(",");
            const rows = await allAsync(`SELECT id, name, price, images FROM products WHERE id IN (${placeholders})`, created.productIds);
            products = rows || [];
          }
        } catch (prodErr) {
          console.warn("Could not fetch product rows after sale creation:", prodErr.message || prodErr);
        }

        return res.json({ message: "Sale created successfully", sale: { id: created.id, name: created.name, productIds: created.productIds, products } });
      } catch (txnErr) {
        console.error("Transaction error creating sale with products:", txnErr);
        return res.status(500).json({ error: "Failed to create sale with products", details: txnErr.message || txnErr });
      }
    }

    // No products provided — simple insert
    const result = await runAsync(`INSERT INTO sales (name) VALUES (?)`, [name]);
    await logAction(req.user.id, "CREATE", "sale", result.lastID, { name });
    res.json({ message: "Sale created successfully", id: result.lastID });
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
    // accept either product_ids or productIds
    const incoming = Array.isArray(req.body.product_ids) ? req.body.product_ids : Array.isArray(req.body.productIds) ? req.body.productIds : [];
    if (!Array.isArray(incoming) || incoming.length === 0)
      return res.status(400).json({ error: "No products provided" });

    // normalize ids
    const normalized = incoming.map((id) => (typeof id === "string" && id.match(/^\d+$/) ? Number(id) : id));

    // Use transaction to insert many product rows
    try {
      await execAsync("BEGIN;");

      const stmt = db.prepare(`INSERT OR IGNORE INTO sale_products (sale_id, product_id, position) VALUES (?, ?, ?)`);

      await new Promise((resolve, reject) => {
        normalized.forEach((pid, idx) => {
          stmt.run([sale_id, pid, idx], (err) => {
            if (err) {
              // collect error but continue; we'll reject on finalize if necessary
              // (we don't abort immediately to allow insert or ignore behavior)
            }
          });
        });
        stmt.finalize((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      await execAsync("COMMIT;");
    } catch (innerErr) {
      console.error("Error inserting sale_products:", innerErr);
      try {
        await execAsync("ROLLBACK;");
      } catch (rerr) {
        console.error("Rollback failed:", rerr);
      }
      return res.status(500).json({ error: "Failed to add products to sale", details: innerErr.message || innerErr });
    }

    await logAction(req.user.id, "CREATE", "sale_product", sale_id, { product_ids: normalized });
    res.json({ message: "Products added to sale successfully", product_ids: normalized });
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
    const sale = await getAsync(`SELECT * FROM sales WHERE id = ?`, [id]);
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const products = await allAsync(
      `SELECT p.id, p.name, p.price, sp.position
         FROM sale_products sp
         JOIN products p ON p.id = sp.product_id
         WHERE sp.sale_id = ?
         ORDER BY sp.position ASC`,
      [id]
    );

    res.json({ sale, products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sale details" });
  }
});

export default router;
