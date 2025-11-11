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
  if (err) {
    console.error("❌ SQLite connection error:", err.message);
  } else {
    console.log("✅ Connected to SQLite at:", dbPath);
  }
});

// Multer config
const uploadsDir = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

/* -------------------------------------------------------------------------- */
/*                            Helper: parseSizeStock                          */
/* -------------------------------------------------------------------------- */
function parseSizeStock(input) {
  if (!input) return {};
  if (typeof input === "object") return input;

  try {
    const parsed = JSON.parse(input);
    if (typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}

  const map = {};
  String(input)
    .split(",")
    .map((p) => p.trim())
    .forEach((pair) => {
      const [size, qty] = pair.split(":").map((x) => x.trim());
      if (size) map[size] = Number(qty) || 0;
    });
  return map;
}

/* -------------------------------------------------------------------------- */
/*                      GET: All Products (Paginated etc.)                    */
/* -------------------------------------------------------------------------- */
router.get("/", (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const sort = (req.query.sort || "newest").trim();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limitRaw = parseInt(req.query.limit, 10) || 20;
    const limit = limitRaw === 999999 ? null : Math.max(limitRaw, 1);
    const offset = limit ? (page - 1) * limit : 0;
    const like = `%${search}%`;

    const ORDER_MAP = {
      newest: "updated_at DESC",
      price_asc: "price ASC",
      price_desc: "price DESC",
      best_selling: "COALESCE(sold,0) DESC",
      low_stock: "stock ASC",
    };

    const isOutOfStockFilter = sort === "out_of_stock";
    const orderClause = ORDER_MAP[sort] || ORDER_MAP.newest;
    const lowStockThreshold = typeof req.query.low_stock_threshold !== "undefined"
      ? Number(req.query.low_stock_threshold)
      : null;

    let whereSQL = `WHERE (name LIKE ? OR category LIKE ? OR subcategory LIKE ?)`;
    const params = [like, like, like];

    if (isOutOfStockFilter) {
      whereSQL += ` AND stock = 0`;
    }

    if (sort === "low_stock" && Number.isFinite(lowStockThreshold)) {
      whereSQL += ` AND stock <= ?`;
      params.push(lowStockThreshold);
    }

    const selectSQL = `
      SELECT id, name, category, subcategory, price, actualPrice, images, colors,
             stock, rating, updated_at, COALESCE(sold,0) AS sold, featured, size_stock
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

/* -------------------------------------------------------------------------- */
/*                          POST: Add Single Product                          */
/* -------------------------------------------------------------------------- */
router.post("/", (req, res) => {
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

    const parsedSizeStock = parseSizeStock(size_stock);
    const totalStock =
      Object.values(parsedSizeStock).reduce((a, b) => a + (Number(b) || 0), 0) ||
      Number(stock) ||
      0;

    db.run(
      `INSERT INTO products 
        (name, category, price, actualPrice, images, rating, sizes, colors,
         originalPrice, description, subcategory, stock, featured, size_stock, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        name.trim(),
        category.trim(),
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
        JSON.stringify(parsedSizeStock),
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

/* -------------------------------------------------------------------------- */
/*                            PUT: Edit Product                               */
/* -------------------------------------------------------------------------- */
router.put("/:id", (req, res) => {
  try {
    const parsedSizeStock = parseSizeStock(req.body.size_stock);
    const totalStock =
      Object.values(parsedSizeStock).reduce((a, b) => a + (Number(b) || 0), 0) ||
      Number(req.body.stock) ||
      0;

    db.run(
      `UPDATE products
       SET name=?, category=?, price=?, actualPrice=?, images=?, rating=?, sizes=?, colors=?,
           originalPrice=?, description=?, subcategory=?, stock=?, featured=?, size_stock=?, updated_at=datetime('now')
       WHERE id=?`,
      [
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
        JSON.stringify(parsedSizeStock),
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

/* -------------------------------------------------------------------------- */
/*                           DELETE: Remove Product                           */
/* -------------------------------------------------------------------------- */
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
      if (!row.name || !row.category || !row.price) return;

      const parsedSizeStock = parseSizeStock(row.size_stock);
      const totalStock =
        Object.values(parsedSizeStock).reduce((a, b) => a + (Number(b) || 0), 0) ||
        Number(row.stock) ||
        0;

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
        size_stock: JSON.stringify(parsedSizeStock),
      });
    })
    .on("end", () => {
      if (products.length === 0) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        return res.status(400).json({ message: "CSV contains no valid product data" });
      }

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const stmt = db.prepare(
          `INSERT INTO products 
            (name, category, price, actualPrice, images, rating, sizes, colors,
             originalPrice, description, subcategory, stock, featured, size_stock, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        );

        for (const p of products) {
          stmt.run([
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
            p.size_stock,
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

/* -------------------------------------------------------------------------- */
/*                           SINGLE PRODUCT ROUTE                             */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/*                             CATEGORY UPDATES                               */
/* -------------------------------------------------------------------------- */
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
/*                           EXPORT ROUTER                                    */
/* -------------------------------------------------------------------------- */
export default router;
