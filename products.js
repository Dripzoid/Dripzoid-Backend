import express from "express";
import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, "..", "dripzoid.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ Products router DB error:", err.message);
  else console.log("✅ Products router connected to DB:", dbPath);
});

const DEFAULT_LIMIT = 16;

const csvToArray = (v) => {
  if (!v) return null;
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
      if (typeof parsed === "string") return [parsed.trim()];
    } catch {}
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return null;
};

/* -------------------- GLOBAL SEARCH -------------------- */
// 🔹 must be ABOVE "/:id" route
router.get("/search", (req, res) => {
  let { query = "", section = "all" } = req.query;
  query = query.trim();

  if (!query) return res.json([]);

  const whereParts = ["(name LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE)"];
  const params = [`%${query}%`, `%${query}%`];

  // Optional section filter
  const sectionMap = {
    men: ["Shirts", "Pants", "Hoodies", "Jeans"],
    women: ["Dresses", "Tops", "Jeans", "Skirts"],
    kids: ["Shirts", "Pants", "Toys", "Hoodies"],
  };

  if (section.toLowerCase() in sectionMap) {
    const cats = sectionMap[section.toLowerCase()];
    const placeholders = cats.map(() => "?").join(",");
    whereParts.push(`category COLLATE NOCASE IN (${placeholders})`);
    params.push(...cats);
  }

  const whereClause = "WHERE " + whereParts.join(" AND ");
  const limit = 20;

  const sql = `
    SELECT id, name, category, subcategory, images
    FROM products
    ${whereClause}
    ORDER BY name COLLATE NOCASE ASC
    LIMIT ?
  `;

  db.all(sql, [...params, limit], (err, rows) => {
    if (err) return res.status(500).json({ message: err.message });

    const normalized = rows.map((r) => {
      let image = null;
      if (r.images) {
        try {
          const parsed = JSON.parse(r.images);
          image = Array.isArray(parsed) ? parsed[0] : parsed;
        } catch {
          image = r.images.split(",")[0]?.trim() || null;
        }
      }

      return {
        id: Number(r.id),
        name: r.name,
        category: r.category || "Uncategorized",
        subcategory: r.subcategory || "General",
        section: section.toLowerCase() || "all",
        image,
      };
    });

    res.json(normalized);
  });
});

/* -------------------- GET PRODUCTS (listing + filters) -------------------- */
router.get("/", (req, res) => {
  let {
    category,
    subcategory,
    colors,
    minPrice,
    maxPrice,
    sort,
    page,
    limit,
    search,
    q,
  } = req.query;

  const searchQuery = (search || q || "").trim();

  // normalize categories
  let categoriesArr = csvToArray(category) || null;
  if (categoriesArr) {
    categoriesArr = categoriesArr.map((c) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase());
  }

  const subcategoriesArr = csvToArray(subcategory);
  const colorsArr = csvToArray(colors);

  console.log("🔍 Products query:", req.query);
  console.log("Parsed categories:", categoriesArr);

  // WHERE clause
  const whereParts = ["1=1"];
  const params = [];

  if (categoriesArr && categoriesArr.length) {
    const placeholders = categoriesArr.map(() => "?").join(",");
    whereParts.push(`category COLLATE NOCASE IN (${placeholders})`);
    params.push(...categoriesArr);
  }

  if (subcategoriesArr && subcategoriesArr.length) {
    const placeholders = subcategoriesArr.map(() => "?").join(",");
    whereParts.push(`subcategory COLLATE NOCASE IN (${placeholders})`);
    params.push(...subcategoriesArr);
  }

  if (colorsArr && colorsArr.length) {
    const placeholders = colorsArr.map(() => "?").join(",");
    whereParts.push(`colors COLLATE NOCASE IN (${placeholders})`);
    params.push(...colorsArr);
  }

  if (minPrice) {
    whereParts.push("price >= ?");
    params.push(parseFloat(minPrice));
  }

  if (maxPrice) {
    whereParts.push("price <= ?");
    params.push(parseFloat(maxPrice));
  }

  if (searchQuery) {
    whereParts.push("(name LIKE ? OR description LIKE ?)");
    params.push(`%${searchQuery}%`, `%${searchQuery}%`);
  }

  const whereClause = "WHERE " + whereParts.join(" AND ");

  // sorting
  let orderBy = "ORDER BY id DESC";
  switch ((sort || "").toLowerCase()) {
    case "price_asc":
    case "low-high":
      orderBy = "ORDER BY price ASC";
      break;
    case "price_desc":
    case "high-low":
      orderBy = "ORDER BY price DESC";
      break;
    case "name_asc":
      orderBy = "ORDER BY name COLLATE NOCASE ASC";
      break;
    case "name_desc":
      orderBy = "ORDER BY name COLLATE NOCASE DESC";
      break;
    case "newest":
      orderBy = "ORDER BY id DESC";
      break;
  }

  // pagination
  const clientProvidedPage = Object.prototype.hasOwnProperty.call(req.query, "page");
  const clientProvidedLimit = Object.prototype.hasOwnProperty.call(req.query, "limit");

  page = page ? parseInt(page, 10) : undefined;
  limit = limit && String(limit).toLowerCase() !== "all" ? parseInt(limit, 10) : undefined;

  const countSql = `SELECT COUNT(*) as total FROM products ${whereClause}`;
  db.get(countSql, params, (err, countRow) => {
    if (err) return res.status(500).json({ message: err.message });

    const total = countRow?.total || 0;
    let finalLimit, finalPage;

    if (!clientProvidedPage && !clientProvidedLimit) {
      finalLimit = DEFAULT_LIMIT;
      finalPage = 1;
    } else if (String(req.query.limit).toLowerCase() === "all") {
      finalLimit = total;
      finalPage = 1;
    } else {
      finalLimit = limit > 0 ? limit : DEFAULT_LIMIT;
      finalPage = page > 0 ? page : 1;
    }

    const finalOffset = (finalPage - 1) * finalLimit;
    const pages = finalLimit > 0 ? Math.ceil(total / finalLimit) : 1;

    const sql = `
      SELECT id, name, category, subcategory, colors, images, price, originalPrice, rating, description, stock
      FROM products
      ${whereClause}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;

    console.log("Final SQL:", sql, params, finalLimit, finalOffset);

    db.all(sql, [...params, finalLimit, finalOffset], (err, rows) => {
      if (err) return res.status(500).json({ message: err.message });

      const normalized = rows.map((r) => ({
        ...r,
        id: Number(r.id),
        price: r.price !== null ? Number(r.price) : null,
        originalPrice: r.originalPrice !== null ? Number(r.originalPrice) : null,
        rating: r.rating !== null ? Number(r.rating) : null,
        stock: r.stock !== null ? Number(r.stock) : 0,
        images: (() => {
          if (!r.images) return [];
          try {
            const parsed = JSON.parse(r.images);
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            return r.images.split(",").map((s) => s.trim());
          }
        })(),
      }));

      res.json({
        meta: { total, page: finalPage, pages, limit: finalLimit },
        data: normalized,
      });
    });
  });
});

/* -------------------- GET SINGLE PRODUCT BY ID -------------------- */
const parseField = (field) => {
  if (!field) return [];
  try {
    return JSON.parse(field);
  } catch {
    return field.split(",").map((v) => v.trim());
  }
};

router.get("/:id", (req, res) => {
  const { id } = req.params;

  const query = `SELECT * FROM products WHERE id = ?`;

  db.get(query, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Product not found" });

    row.sizes = parseField(row.sizes);
    row.colors = parseField(row.colors);
    row.images = parseField(row.images);

    res.json(row);
  });
});

/* -------------------- RELATED PRODUCTS -------------------- */
router.get("/related/:id", (req, res) => {
  const { id } = req.params;

  // First, get the product’s category & subcategory
  const query = `SELECT category, subcategory FROM products WHERE id = ?`;

  db.get(query, [id], (err, product) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!product) return res.status(404).json({ error: "Product not found" });

    // Fetch related products in the same category/subcategory, excluding the current one
    const relatedQuery = `
      SELECT id, name, category, subcategory, images, price, rating
      FROM products
      WHERE category = ? AND subcategory = ? AND id != ?
      ORDER BY RANDOM()
      LIMIT 8
    `;

    db.all(relatedQuery, [product.category, product.subcategory, id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const normalized = rows.map((r) => ({
        ...r,
        id: Number(r.id),
        price: r.price !== null ? Number(r.price) : null,
        rating: r.rating !== null ? Number(r.rating) : null,
        images: (() => {
          if (!r.images) return [];
          try {
            const parsed = JSON.parse(r.images);
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            return r.images.split(",").map((s) => s.trim());
          }
        })(),
      }));

      res.json(normalized);
    });
  });
});

export default router;
