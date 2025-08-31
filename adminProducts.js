// backend/routes/adminProducts.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import csvParser from "csv-parser";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// SQLite connection
const db = new sqlite3.Database(
  path.resolve(__dirname, "../dripzoid.db"),
  (err) => {
    if (err) {
      console.error("❌ SQLite connection error:", err.message);
    } else {
      console.log("✅ Connected to SQLite for admin products");
    }
  }
);

// Multer config
const uploadsDir = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

/**
 * GET: All Products (paginated, search, sorting)
 *
 * Supported sort values:
 * - newest         -> updated_at DESC
 * - price_asc      -> price ASC
 * - price_desc     -> price DESC
 * - best_selling   -> COALESCE(sold,0) DESC
 * - out_of_stock   -> filter WHERE stock = 0
 * - low_stock      -> ORDER BY stock ASC (optionally filter by low_stock_threshold)
 *
 * Query params:
 * - search (string)
 * - sort (string)
 * - page (number)
 * - limit (number) - pass 999999 to "show all"
 * - low_stock_threshold (optional number)
 */
router.get("/", (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const sort = (req.query.sort || "newest").trim();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limitRaw = parseInt(req.query.limit, 10) || 20;
    const limit = limitRaw === 999999 ? null : Math.max(limitRaw, 1);
    const offset = limit ? (page - 1) * limit : 0;
    const like = `%${search}%`;

    // Whitelist order clauses
    const ORDER_MAP = {
      newest: "updated_at DESC",
      price_asc: "price ASC",
      price_desc: "price DESC",
      best_selling: "COALESCE(sold,0) DESC",
      low_stock: "stock ASC",
    };

    const isOutOfStockFilter = sort === "out_of_stock";
    const orderClause = ORDER_MAP[sort] || ORDER_MAP.newest;

    // Optionally treat low_stock with threshold filter (if provided)
    const lowStockThreshold = typeof req.query.low_stock_threshold !== "undefined"
      ? Number(req.query.low_stock_threshold)
      : null;

    // Build WHERE clause safely with params
    let whereSQL = `WHERE (name LIKE ? OR category LIKE ? OR subcategory LIKE ?)`;
    const params = [like, like, like];

    if (isOutOfStockFilter) {
      whereSQL += ` AND stock = 0`;
    }

    if (sort === "low_stock" && Number.isFinite(lowStockThreshold)) {
      // When threshold provided, filter to stock <= threshold (useful)
      whereSQL += ` AND stock <= ?`;
      params.push(lowStockThreshold);
    }

    // SELECT clause (include sold fallback)
    const selectSQL = `
      SELECT id, name, category, subcategory, price, images, stock, rating, updated_at, COALESCE(sold,0) AS sold
      FROM products
      ${whereSQL}
      ORDER BY ${orderClause}
      ${limit ? "LIMIT ? OFFSET ?" : ""}
    `;

    const countSQL = `
      SELECT COUNT(*) AS total
      FROM products
      ${whereSQL}
    `;

    const selectParams = limit ? [...params, limit, offset] : [...params];

    db.all(selectSQL, selectParams, (err, rows) => {
      if (err) {
        console.error("Products list error:", err);
        return res.status(500).json({ message: "DB error", detail: err.message });
      }

      db.get(countSQL, params, (err2, countRow) => {
        if (err2) {
          console.error("Products count error:", err2);
          return res.status(500).json({ message: "DB error", detail: err2.message });
        }

        return res.json({
          data: rows || [],
          total: countRow?.total || 0,
          page,
          limit: limit ?? "all",
        });
      });
    });
  } catch (ex) {
    console.error("Unhandled error in GET /admin/products:", ex);
    res.status(500).json({ message: "Server error", detail: ex.message });
  }
});

/**
 * POST: Add Single Product
 */
router.post("/", (req, res) => {
  try {
    let {
      name,
      category,
      price,
      images,
      rating,
      sizes,
      color,
      originalPrice,
      description,
      subcategory,
      stock,
    } = req.body;

    if (!name || !category || price == null) {
      return res.status(400).json({ message: "Name, category, and price are required" });
    }

    price = Number(price) || 0;
    rating = Number(rating) || 0;
    originalPrice = Number(originalPrice) || 0;
    stock = Number(stock) || 0;

    db.run(
      `INSERT INTO products 
        (name, category, price, images, rating, sizes, color, originalPrice, description, subcategory, stock, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        name.trim(),
        category.trim(),
        price,
        images || "",
        rating,
        sizes || "",
        color || "",
        originalPrice,
        description || "",
        subcategory || "",
        stock,
      ],
      function (err) {
        if (err) {
          console.error("Insert product error:", err);
          return res.status(500).json({ message: "DB insert error", detail: err.message });
        }

        db.get("SELECT * FROM products WHERE id = ?", [this.lastID], (err2, row) => {
          if (err2) {
            console.error("Fetch new product error:", err2);
            return res.status(500).json({ message: "DB read error", detail: err2.message });
          }
          return res.json(row);
        });
      }
    );
  } catch (ex) {
    console.error("Unhandled error in POST /admin/products:", ex);
    res.status(500).json({ message: "Server error", detail: ex.message });
  }
});

/**
 * PUT: Edit Product
 */
router.put("/:id", (req, res) => {
  try {
    let {
      name,
      category,
      price,
      images,
      rating,
      sizes,
      color,
      originalPrice,
      description,
      subcategory,
      stock,
    } = req.body;

    price = Number(price) || 0;
    rating = Number(rating) || 0;
    originalPrice = Number(originalPrice) || 0;
    stock = Number(stock) || 0;

    db.run(
      `UPDATE products
       SET name = ?, category = ?, price = ?, images = ?, rating = ?, sizes = ?, color = ?, originalPrice = ?, description = ?, subcategory = ?, stock = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        (name || "").trim(),
        (category || "").trim(),
        price,
        images || "",
        rating,
        sizes || "",
        color || "",
        originalPrice,
        description || "",
        subcategory || "",
        stock,
        req.params.id,
      ],
      function (err) {
        if (err) {
          console.error("Update product error:", err);
          return res.status(500).json({ message: "DB update error", detail: err.message });
        }
        if (this.changes === 0) return res.status(404).json({ message: "Product not found" });

        db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err2, row) => {
          if (err2) {
            console.error("Fetch updated product error:", err2);
            return res.status(500).json({ message: "DB read error", detail: err2.message });
          }
          return res.json(row);
        });
      }
    );
  } catch (ex) {
    console.error("Unhandled error in PUT /admin/products/:id:", ex);
    res.status(500).json({ message: "Server error", detail: ex.message });
  }
});

/**
 * DELETE: Remove Product
 */
router.delete("/:id", (req, res) => {
  try {
    db.run("DELETE FROM products WHERE id = ?", [req.params.id], function (err) {
      if (err) {
        console.error("Delete product error:", err);
        return res.status(500).json({ message: "DB delete error", detail: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ message: "Product not found" });
      return res.json({ id: req.params.id, message: "✅ Product deleted successfully" });
    });
  } catch (ex) {
    console.error("Unhandled error in DELETE /admin/products/:id:", ex);
    res.status(500).json({ message: "Server error", detail: ex.message });
  }
});

/**
 * POST: Bulk Upload Products via CSV
 */
router.post("/bulk-upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No CSV file uploaded" });

  const filePath = req.file.path;
  const products = [];

  fs.createReadStream(filePath)
    .pipe(csvParser())
    .on("data", (row) => {
      if (!row.name || !row.category || !row.price) return;

      products.push({
        name: row.name.trim(),
        category: row.category.trim(),
        price: Number(row.price) || 0,
        images: row.images || "",
        rating: Number(row.rating) || 0,
        sizes: row.sizes || "",
        color: row.color || "",
        originalPrice: Number(row.originalPrice) || 0,
        description: row.description || "",
        subcategory: row.subcategory || "",
        stock: Number(row.stock) || 0,
      });
    })
    .on("end", () => {
      if (products.length === 0) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        return res.status(400).json({ message: "CSV contains no valid product data" });
      }

      // Insert in a transaction
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const stmt = db.prepare(
          `INSERT INTO products 
            (name, category, price, images, rating, sizes, color, originalPrice, description, subcategory, stock, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        );

        for (const p of products) {
          stmt.run([
            p.name,
            p.category,
            p.price,
            p.images,
            p.rating,
            p.sizes,
            p.color,
            p.originalPrice,
            p.description,
            p.subcategory,
            p.stock,
          ]);
        }

        stmt.finalize((err) => {
          if (err) {
            console.error("Bulk insert finalize error:", err);
            db.run("ROLLBACK", () => {
              try { fs.unlinkSync(filePath); } catch (e) {}
              return res.status(500).json({ message: "Bulk insert error", detail: err.message });
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
    })
    .on("error", (err) => {
      try { fs.unlinkSync(filePath); } catch (e) {}
      console.error("CSV parse error:", err);
      res.status(500).json({ message: "CSV parse error", detail: err.message });
    });
});

/**
 * GET: Single Product by ID
 */
router.get("/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product ID" });

    db.get("SELECT * FROM products WHERE id = ?", [id], (err, row) => {
      if (err) {
        console.error("Fetch single product error:", err);
        return res.status(500).json({ message: "DB error", detail: err.message });
      }
      if (!row) return res.status(404).json({ message: "Product not found" });
      return res.json(row);
    });
  } catch (ex) {
    console.error("Unhandled error in GET /admin/products/:id:", ex);
    res.status(500).json({ message: "Server error", detail: ex.message });
  }
});

export default router;
