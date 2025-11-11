// backend/routes/adminProducts.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import csvParser from "csv-parser";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

// Use DATABASE_FILE from .env or fallback to local file
const dbPath = process.env.DATABASE_FILE || path.resolve(__dirname, "./dripzoid.db");

// SQLite connection
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ SQLite connection error:", err.message);
  else console.log("✅ Connected to SQLite at:", dbPath);
});

// Multer config for uploads
const uploadsDir = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

/* ----------------------------- helpers ---------------------------------- */

// parse size_stock input. Accepts object, JSON string, or "S:10,M:5" style.
function parseSizeStock(input) {
  if (!input) return {};
  if (typeof input === "object") return input;
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (e) {
    // ignore
  }
  const map = {};
  String(input)
    .split(",")
    .map((p) => p.trim())
    .forEach((pair) => {
      if (!pair) return;
      const [size, qty] = pair.split(":").map((s) => (s ? s.trim() : s));
      if (size) map[size] = Number(qty) || 0;
    });
  return map;
}

// Promise wrappers for sqlite3 callbacks
function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}
function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}
function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      // return lastID and changes for caller
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/* -------------------------------------------------------------------------- */
/*                      GET: All Products (paginated + sizes)                 */
/* -------------------------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limitRaw = parseInt(req.query.limit, 10) || 20;
    const limit = limitRaw === 999999 ? null : Math.max(limitRaw, 1);
    const offset = limit ? (page - 1) * limit : 0;
    const like = `%${search}%`;

    const sort = (req.query.sort || "newest").trim();
    const ORDER_MAP = {
      newest: "p.updated_at DESC",
      price_asc: "p.price ASC",
      price_desc: "p.price DESC",
      best_selling: "COALESCE(p.sold,0) DESC",
      low_stock: "total_stock ASC",
    };
    const orderClause = ORDER_MAP[sort] || ORDER_MAP.newest;

    // Count total (without sizes aggregation)
    const countSQL = `
      SELECT COUNT(*) AS total
      FROM products p
      WHERE (p.name LIKE ? OR p.category LIKE ? OR p.subcategory LIKE ?)
    `;
    const countRow = await dbGetAsync(countSQL, [like, like, like]);
    const total = Number(countRow?.total || 0);

    // Fetch product rows with requested pagination
    const selectSQL = `
      SELECT p.*
      FROM products p
      WHERE (p.name LIKE ? OR p.category LIKE ? OR p.subcategory LIKE ?)
      ORDER BY ${orderClause}
      ${limit ? "LIMIT ? OFFSET ?" : ""}
    `;
    const selectParams = limit ? [like, like, like, limit, offset] : [like, like, like];
    const products = await dbAllAsync(selectSQL, selectParams);

    // For each product fetch sizes from product_sizes
    const enriched = await Promise.all(
      products.map(async (p) => {
        const sizes = await dbAllAsync(`SELECT size, stock FROM product_sizes WHERE product_id = ?`, [p.id]);
        const sizesFormatted = (sizes || []).map((s) => ({ size: s.size, stock: Number(s.stock || 0) }));
        const totalStock = sizesFormatted.reduce((acc, it) => acc + Number(it.stock || 0), 0);
        // if product.stock is present and sizes empty, keep product.stock
        const finalTotal = totalStock || Number(p.stock || 0);
        return { ...p, sizes: sizesFormatted, totalStock: finalTotal };
      })
    );

    return res.json({
      data: enriched,
      total,
      page,
      limit: limit ?? "all",
    });
  } catch (err) {
    console.error("Unhandled error in GET /admin/products:", err);
    return res.status(500).json({ message: "Server error", detail: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                          POST: Add Single Product                          */
/* -------------------------------------------------------------------------- */
router.post("/", async (req, res) => {
  try {
    let {
      name,
      category,
      price,
      actualPrice,
      images,
      rating,
      sizes,
      colors,
      color,
      originalPrice,
      description,
      subcategory,
      stock,
      featured,
      size_stock,
    } = req.body;

    colors = (colors || color || "").toString();

    if (!name || !category || price == null) {
      return res.status(400).json({ message: "Name, category, and price are required" });
    }

    // parse sizes mapping
    const parsedSizeStock = parseSizeStock(size_stock);
    const totalFromSizes = Object.values(parsedSizeStock).reduce((a, b) => a + (Number(b) || 0), 0);
    const totalStock = totalFromSizes || Number(stock) || 0;

    // Insert product
    const insertSQL = `
      INSERT INTO products
        (name, category, price, actualPrice, images, rating, sizes, colors,
         originalPrice, description, subcategory, stock, featured, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `;
    const insertParams = [
      (name || "").trim(),
      (category || "").trim(),
      Number(price) || 0,
      Number(actualPrice) || 0,
      images || "",
      Number(rating) || 0,
      sizes || "",
      colors || "",
      Number(originalPrice) || 0,
      description || "",
      subcategory || "",
      totalStock,
      Number(featured) || 0,
    ];

    const { lastID } = await dbRunAsync(insertSQL, insertParams);
    const productId = lastID;

    // Insert product_sizes for each size
    if (parsedSizeStock && Object.keys(parsedSizeStock).length > 0) {
      const insertSizeStmt = db.prepare(`INSERT INTO product_sizes (product_id, size, stock) VALUES (?, ?, ?)`);
      for (const [size, qty] of Object.entries(parsedSizeStock)) {
        insertSizeStmt.run([productId, size, Number(qty) || 0]);
      }
      insertSizeStmt.finalize();
    }

    // Return new product with sizes
    const productRow = await dbGetAsync(`SELECT * FROM products WHERE id = ?`, [productId]);
    const sizesRows = await dbAllAsync(`SELECT size, stock FROM product_sizes WHERE product_id = ?`, [productId]);
    const sizesFormatted = (sizesRows || []).map((s) => ({ size: s.size, stock: Number(s.stock || 0) }));
    const total = sizesFormatted.reduce((a, b) => a + Number(b.stock || 0), 0) || Number(productRow.stock || 0);

    return res.json({ ...productRow, sizes: sizesFormatted, totalStock: total });
  } catch (err) {
    console.error("Unhandled error in POST /admin/products:", err);
    return res.status(500).json({ message: "Server error", detail: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                            PUT: Edit Product                               */
/* -------------------------------------------------------------------------- */
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product id" });

    const parsedSizeStock = parseSizeStock(req.body.size_stock);
    const totalFromSizes = Object.values(parsedSizeStock).reduce((a, b) => a + (Number(b) || 0), 0);
    const totalStock = totalFromSizes || Number(req.body.stock) || 0;

    const updateSQL = `
      UPDATE products
      SET name = ?, category = ?, price = ?, actualPrice = ?, images = ?, rating = ?, sizes = ?, colors = ?,
          originalPrice = ?, description = ?, subcategory = ?, stock = ?, featured = ?, updated_at = datetime('now')
      WHERE id = ?
    `;
    const updateParams = [
      (req.body.name || "").trim(),
      (req.body.category || "").trim(),
      Number(req.body.price) || 0,
      Number(req.body.actualPrice) || 0,
      req.body.images || "",
      Number(req.body.rating) || 0,
      req.body.sizes || "",
      (req.body.colors || req.body.color || "").toString(),
      Number(req.body.originalPrice) || 0,
      req.body.description || "",
      req.body.subcategory || "",
      totalStock,
      Number(req.body.featured) || 0,
      id,
    ];

    const { changes } = await dbRunAsync(updateSQL, updateParams);
    if (!changes) return res.status(404).json({ message: "Product not found" });

    // Replace product_sizes: delete existing and insert new sizes
    await dbRunAsync(`DELETE FROM product_sizes WHERE product_id = ?`, [id]);
    if (parsedSizeStock && Object.keys(parsedSizeStock).length > 0) {
      const insertSizeStmt = db.prepare(`INSERT INTO product_sizes (product_id, size, stock) VALUES (?, ?, ?)`);
      for (const [size, qty] of Object.entries(parsedSizeStock)) {
        insertSizeStmt.run([id, size, Number(qty) || 0]);
      }
      insertSizeStmt.finalize();
    }

    // Return updated product with sizes
    const productRow = await dbGetAsync(`SELECT * FROM products WHERE id = ?`, [id]);
    const sizesRows = await dbAllAsync(`SELECT size, stock FROM product_sizes WHERE product_id = ?`, [id]);
    const sizesFormatted = (sizesRows || []).map((s) => ({ size: s.size, stock: Number(s.stock || 0) }));
    const total = sizesFormatted.reduce((a, b) => a + Number(b.stock || 0), 0) || Number(productRow.stock || 0);

    return res.json({ ...productRow, sizes: sizesFormatted, totalStock: total });
  } catch (err) {
    console.error("Unhandled error in PUT /admin/products/:id:", err);
    return res.status(500).json({ message: "Server error", detail: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                           DELETE: Remove Product                           */
/* -------------------------------------------------------------------------- */
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product id" });

    await dbRunAsync("DELETE FROM product_sizes WHERE product_id = ?", [id]);
    const { changes } = await dbRunAsync("DELETE FROM products WHERE id = ?", [id]);
    if (!changes) return res.status(404).json({ message: "Product not found" });

    return res.json({ id, message: "✅ Product deleted successfully" });
  } catch (err) {
    console.error("Unhandled error in DELETE /admin/products/:id:", err);
    return res.status(500).json({ message: "Server error", detail: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                     POST: Bulk Upload Products via CSV                     */
/* -------------------------------------------------------------------------- */
router.post("/bulk-upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No CSV file uploaded" });

  const filePath = req.file.path;
  const products = [];

  fs.createReadStream(filePath)
    .pipe(csvParser())
    .on("data", (row) => {
      // require minimal fields
      if (!row.name || !row.category || !row.price) return;

      const parsedSizeStock = parseSizeStock(row.size_stock);
      const totalFromSizes = Object.values(parsedSizeStock).reduce((a, b) => a + (Number(b) || 0), 0);
      const totalStock = totalFromSizes || Number(row.stock) || 0;

      products.push({
        name: row.name.trim(),
        category: row.category.trim(),
        price: Number(row.price) || 0,
        actualPrice: Number(row.actualPrice) || 0,
        images: row.images || "",
        rating: Number(row.rating) || 0,
        sizes: row.sizes || "",
        colors: row.colors || row.color || "",
        originalPrice: Number(row.originalPrice) || 0,
        description: row.description || "",
        subcategory: row.subcategory || "",
        stock: totalStock,
        featured: Number(row.featured) || 0,
        size_stock: parsedSizeStock, // keep as object for insertion below
      });
    })
    .on("end", () => {
      if (products.length === 0) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        return res.status(400).json({ message: "CSV contains no valid product data" });
      }

      // Insert products + sizes inside a transaction
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const insertProduct = db.prepare(
          `INSERT INTO products
            (name, category, price, actualPrice, images, rating, sizes, colors,
             originalPrice, description, subcategory, stock, featured, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        );

        const insertSize = db.prepare(`INSERT INTO product_sizes (product_id, size, stock) VALUES (?, ?, ?)`);

        for (const p of products) {
          insertProduct.run(
            [
              p.name,
              p.category,
              p.price,
              p.actualPrice,
              p.images,
              p.rating,
              p.sizes,
              p.colors,
              p.originalPrice,
              p.description,
              p.subcategory,
              p.stock,
              p.featured,
            ],
            function (err) {
              if (err) {
                console.error("Bulk product insert error:", err);
                // we continue; error will be handled on finalize/commit
                return;
              }
              const pid = this.lastID;
              if (p.size_stock && Object.keys(p.size_stock).length > 0) {
                for (const [size, qty] of Object.entries(p.size_stock)) {
                  insertSize.run([pid, size, Number(qty) || 0]);
                }
              }
            }
          );
        }

        // finalize prepared statements, then commit
        insertProduct.finalize((prodErr) => {
          if (prodErr) {
            console.error("Bulk insert finalize error (product):", prodErr);
            db.run("ROLLBACK", () => {
              try { fs.unlinkSync(filePath); } catch (e) {}
              return res.status(500).json({ message: "Bulk insert error", detail: prodErr.message });
            });
            return;
          }

          insertSize.finalize((sizeErr) => {
            if (sizeErr) {
              console.error("Bulk insert finalize error (size):", sizeErr);
              db.run("ROLLBACK", () => {
                try { fs.unlinkSync(filePath); } catch (e) {}
                return res.status(500).json({ message: "Bulk insert error", detail: sizeErr.message });
              });
              return;
            }

            db.run("COMMIT", (commitErr) => {
              try { fs.unlinkSync(filePath); } catch (e) {}
              if (commitErr) {
                console.error("Bulk insert commit error:", commitErr);
                return res.status(500).json({ message: "Bulk insert commit error", detail: commitErr.message });
              }
              return res.json({ message: `✅ Bulk upload complete. ${products.length} products added.` });
            });
          });
        });
      });
    })
    .on("error", (err) => {
      try { fs.unlinkSync(filePath); } catch (e) {}
      console.error("CSV parse error:", err);
      return res.status(500).json({ message: "CSV parse error", detail: err.message });
    });
});

/* -------------------------------------------------------------------------- */
/*                              CATEGORY ROUTES                               */
/* -------------------------------------------------------------------------- */
router.get("/categories", (req, res) => {
  const sql = `
    SELECT id, category, subcategory, slug, status, sort_order,
           parent_id, metadata, is_deleted, created_at, updated_at
    FROM categories
    WHERE is_deleted = 0
    ORDER BY category, sort_order, subcategory
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Fetch categories error:", err);
      return res.status(500).json({ message: "DB error", detail: err.message });
    }
    return res.json(rows || []);
  });
});

router.post("/categories", (req, res) => {
  try {
    const {
      category,
      subcategory,
      slug,
      status = "active",
      sort_order = 0,
      parent_id = null,
      metadata = "{}",
    } = req.body;

    if (!category || !subcategory) {
      return res.status(400).json({ message: "Category and subcategory are required" });
    }

    const sql = `
      INSERT INTO categories 
        (category, subcategory, slug, status, sort_order, parent_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `;

    db.run(sql, [category, subcategory, slug, status, sort_order, parent_id, metadata], function (err) {
      if (err) {
        console.error("Insert category error:", err);
        return res.status(500).json({ message: "DB insert error", detail: err.message });
      }
      db.get("SELECT * FROM categories WHERE id = ?", [this.lastID], (err2, row) => {
        if (err2) {
          console.error("Fetch new category error:", err2);
          return res.status(500).json({ message: "DB read error", detail: err2.message });
        }
        return res.json(row);
      });
    });
  } catch (ex) {
    console.error("Unhandled error in POST /admin/categories:", ex);
    res.status(500).json({ message: "Server error", detail: ex.message });
  }
});

router.put("/categories/:id/status", (req, res) => {
  const { status } = req.body;

  db.run(
    `UPDATE categories 
     SET status = ?, updated_at = datetime('now') 
     WHERE id = ?`,
    [status, req.params.id],
    function (err) {
      if (err) {
        console.error("Update status error:", err);
        return res.status(500).json({ message: "DB update error", detail: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ message: "Category not found" });

      db.get("SELECT * FROM categories WHERE id = ?", [req.params.id], (err2, row) => {
        if (err2) {
          console.error("Fetch updated category error:", err2);
          return res.status(500).json({ message: "DB read error", detail: err2.message });
        }
        return res.json(row);
      });
    }
  );
});

router.put("/categories/:id", (req, res) => {
  const { subcategory, slug, status, sort_order, parent_id, metadata } = req.body;

  db.run(
    `UPDATE categories
     SET subcategory = ?, slug = ?, status = ?, sort_order = ?, parent_id = ?, metadata = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [subcategory, slug, status, sort_order, parent_id, metadata, req.params.id],
    function (err) {
      if (err) {
        console.error("Update category error:", err);
        return res.status(500).json({ message: "DB update error", detail: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ message: "Category not found" });

      db.get("SELECT * FROM categories WHERE id = ?", [req.params.id], (err2, row) => {
        if (err2) {
          console.error("Fetch updated category error:", err2);
          return res.status(500).json({ message: "DB read error", detail: err2.message });
        }
        return res.json(row);
      });
    }
  );
});

/* -------------------------------------------------------------------------- */
/*                           SINGLE PRODUCT ROUTE                             */
/* -------------------------------------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product ID" });

    const product = await dbGetAsync("SELECT * FROM products WHERE id = ?", [id]);
    if (!product) return res.status(404).json({ message: "Product not found" });

    const sizes = await dbAllAsync("SELECT size, stock FROM product_sizes WHERE product_id = ?", [id]);
    const sizesFormatted = (sizes || []).map((s) => ({ size: s.size, stock: Number(s.stock || 0) }));
    const total = sizesFormatted.reduce((a, b) => a + Number(b.stock || 0), 0) || Number(product.stock || 0);

    return res.json({ ...product, sizes: sizesFormatted, totalStock: total });
  } catch (err) {
    console.error("Unhandled error in GET /admin/products/:id:", err);
    return res.status(500).json({ message: "Server error", detail: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                           EXPORT ROUTER                                    */
/* -------------------------------------------------------------------------- */
export default router;
