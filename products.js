import express from "express";
import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use env var or fallback to local file
const dbPath = process.env.DATABASE_FILE || path.join(__dirname, "./dripzoid.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("❌ Products router DB error:", err.message);
  } else {
    console.log("✅ Products router connected to DB:", dbPath);
  }
});

const DEFAULT_LIMIT = 16;

/* -------------------- UTILITIES -------------------- */
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

const parseField = (field) => {
  if (!field) return [];
  try {
    return JSON.parse(field);
  } catch {
    return String(field).split(",").map((v) => v.trim()).filter(Boolean);
  }
};

/**
 * Return array of { size, stock } rows for a product_id
 * Resolves to [] on any DB error
 */
const getSizesForProduct = (productId) =>
  new Promise((resolve) => {
    const sql = `SELECT size, stock FROM product_sizes WHERE product_id = ? ORDER BY id ASC`;
    db.all(sql, [productId], (err, rows) => {
      if (err) {
        // If product_sizes table doesn't exist or error, fallback to empty
        return resolve([]);
      }
      if (!rows || rows.length === 0) return resolve([]);
      resolve(rows.map((r) => ({ size: r.size, stock: Number(r.stock) || 0 })));
    });
  });

/* -------------------- GLOBAL SEARCH -------------------- */
// must be above "/:id" route
router.get("/search", (req, res) => {
  let { query = "", section = "all" } = req.query;
  query = String(query).trim();
  if (!query) return res.json([]);

  const whereParts = ["(name LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE)"];
  const params = [`%${query}%`, `%${query}%`];

  // Optional section filter (simple mapping; adjust to your real mapping)
  const sectionMap = {
    men: ["Shirts", "Pants", "Hoodies", "Jeans"],
    women: ["Dresses", "Tops", "Jeans", "Skirts"],
    kids: ["Shirts", "Pants", "Toys", "Hoodies"],
  };

  if (section && sectionMap[String(section).toLowerCase()]) {
    const cats = sectionMap[String(section).toLowerCase()];
    const placeholders = cats.map(() => "?").join(",");
    whereParts.push(`category COLLATE NOCASE IN (${placeholders})`);
    params.push(...cats);
  }

  const limit = 20;
  const sql = `
    SELECT id, name, category, subcategory, images
    FROM products
    WHERE ${whereParts.join(" AND ")}
    ORDER BY name COLLATE NOCASE ASC
    LIMIT ?
  `;

  db.all(sql, [...params, limit], async (err, rows) => {
    if (err) return res.status(500).json({ message: err.message });

    const enriched = await Promise.all(
      (rows || []).map(async (r) => {
        let image = null;
        if (r.images) {
          try {
            const parsed = JSON.parse(r.images);
            image = Array.isArray(parsed) ? parsed[0] : parsed;
          } catch {
            image = String(r.images).split(",")[0]?.trim() || null;
          }
        }

        const sizesArr = await getSizesForProduct(r.id);
        // size_stock as object mapping {S:10, M:5}
        const sizeStockMap = {};
        sizesArr.forEach((s) => {
          if (s && s.size) sizeStockMap[String(s.size)] = Number(s.stock || 0);
        });

        const totalStock = Object.values(sizeStockMap).reduce((acc, v) => acc + Number(v || 0), 0);

        return {
          id: Number(r.id),
          name: r.name,
          category: r.category || "Uncategorized",
          subcategory: r.subcategory || "General",
          section: String(section).toLowerCase() || "all",
          image,
          sizes: sizesArr.map((s) => s.size), // ["S","M","L"]
          sizeStock: sizeStockMap, // object
          size_stock: JSON.stringify(sizeStockMap), // string for older clients expecting JSON string
          sizeRows: sizesArr,
          totalStock,
        };
      })
    );

    res.json(enriched);
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
    gender,
  } = req.query;

  const searchQuery = String(search || q || "").trim();

  let categoriesArr = csvToArray(category) || null;
  if (categoriesArr) categoriesArr = categoriesArr.map((c) => String(c).trim());

  // Map gender -> category filter if provided
  if (gender) {
    const g = String(gender).trim().toLowerCase();
    if (g === "men" || g === "man") categoriesArr = ["Men"];
    else if (g === "women" || g === "woman") categoriesArr = ["Women"];
    else if (g === "kids" || g === "kid" || g === "child") categoriesArr = ["Kids"];
  }

  const subcategoriesArr = csvToArray(subcategory);
  const colorsArr = csvToArray(colors);

  // WHERE parts
  const whereParts = [];
  const params = [];

  // Exclude rows without a price (keep behaviour from your previous code)
  whereParts.push("price IS NOT NULL");

  if (categoriesArr && categoriesArr.length) {
    const placeholders = categoriesArr.map(() => "?").join(",");
    whereParts.push(`category COLLATE NOCASE IN (${placeholders})`);
    params.push(...categoriesArr);
  }

  // Subcategory handling: supports "Category:Subcategory" pairs or simple subcategory names
  if (subcategoriesArr && subcategoriesArr.length) {
    const decodedEntries = subcategoriesArr.map((entry) => {
      try {
        return decodeURIComponent(String(entry));
      } catch {
        return String(entry);
      }
    });

    const pairEntries = decodedEntries.filter((s) => String(s).includes(":"));
    const simpleSubs = decodedEntries.filter((s) => !String(s).includes(":"));

    const orParts = [];

    if (pairEntries.length) {
      const pairClauseParts = pairEntries.map(() => "(category COLLATE NOCASE = ? AND subcategory COLLATE NOCASE = ?)");
      orParts.push(...pairClauseParts);
      pairEntries.forEach((rawPair) => {
        const [rawCat = "", rawSub = ""] = String(rawPair).split(":");
        params.push(rawCat.trim(), rawSub.trim());
      });
    }

    if (simpleSubs.length) {
      const placeholders = simpleSubs.map(() => "?").join(",");
      orParts.push(`subcategory COLLATE NOCASE IN (${placeholders})`);
      params.push(...simpleSubs);
    }

    if (orParts.length) whereParts.push(`(${orParts.join(" OR ")})`);
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

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  // Sorting
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

  // pagination parsing
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
      SELECT id, name, category, subcategory, colors, images,
             price, originalPrice, rating, description, stock
      FROM products
      ${whereClause}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;

    // Fetch rows
    db.all(sql, [...params, finalLimit, finalOffset], async (err, rows) => {
      if (err) return res.status(500).json({ message: err.message });

      // Enrich each row with sizes mapping
      const enriched = await Promise.all(
        (rows || []).map(async (r) => {
          // parse images
          const images = (() => {
            if (!r.images) return [];
            try {
              const parsed = JSON.parse(r.images);
              return Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              return String(r.images).split(",").map((s) => s.trim()).filter(Boolean);
            }
          })();

          // fetch product_sizes rows
          const sizesArr = await getSizesForProduct(r.id); // [ {size, stock}, ... ]
          const sizeStockMap = {};
          sizesArr.forEach((s) => {
            if (s && s.size) sizeStockMap[String(s.size)] = Number(s.stock || 0);
          });

          const totalStock = Object.values(sizeStockMap).reduce((acc, v) => acc + Number(v || 0), 0);

          return {
            id: Number(r.id),
            name: r.name,
            category: r.category,
            subcategory: r.subcategory,
            colors: parseField(r.colors),
            images,
            price: r.price !== null ? Number(r.price) : null,
            originalPrice: r.originalPrice !== null ? Number(r.originalPrice) : null,
            rating: r.rating !== null ? Number(r.rating) : null,
            description: r.description,
            // preserve raw DB stock but also include computed totalStock
            stock: r.stock !== null ? Number(r.stock) : 0,
            totalStock,
            // mapped per-size values and compatibility fields:
            sizes: sizesArr.map((s) => s.size), // ["S","M"]
            sizeStock: sizeStockMap, // object { S:10, M:5 }
            size_stock: JSON.stringify(sizeStockMap),
            sizeRows: sizesArr, // the raw rows [{size,stock}, ...]
          };
        })
      );

      res.json({
        meta: { total, page: finalPage, pages, limit: finalLimit },
        data: enriched,
      });
    });
  });
});

/* -------------------- COLORS LIST -------------------- */
router.get("/colors", (req, res) => {
  const sql = `SELECT DISTINCT colors FROM products WHERE colors IS NOT NULL AND TRIM(colors) != ''`;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    let allColors = [];
    rows.forEach((r) => {
      if (!r.colors) return;
      try {
        const parsed = JSON.parse(r.colors);
        if (Array.isArray(parsed)) {
          allColors.push(...parsed.map((c) => String(c).trim()).filter(Boolean));
        } else if (typeof parsed === "string") {
          allColors.push(parsed.trim());
        }
      } catch {
        allColors.push(...String(r.colors).split(",").map((c) => c.trim()).filter(Boolean));
      }
    });

    const uniqueColors = [...new Set(allColors)];
    res.json({ colors: uniqueColors });
  });
});

/* -------------------- CATEGORIES + SUBCATEGORIES -------------------- */
router.get("/categories", (req, res) => {
  const { category } = req.query;

  const whereParts = ["category IS NOT NULL", "TRIM(category) != ''"];
  const params = [];

  if (category) {
    whereParts.push("category COLLATE NOCASE = ?");
    params.push(category);
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  const sql = `
    SELECT DISTINCT category, subcategory
    FROM products
    ${whereClause}
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const categoriesMap = {};
    rows.forEach(({ category, subcategory }) => {
      const cat = category?.trim() || "Uncategorized";
      const sub = subcategory?.trim() || "General";
      if (!categoriesMap[cat]) categoriesMap[cat] = new Set();
      categoriesMap[cat].add(sub);
    });

    const categories = Object.entries(categoriesMap).map(([name, subs]) => ({
      name,
      subcategories: [...subs],
    }));

    res.json({ categories });
  });
});

/* -------------------- RELATED PRODUCTS -------------------- */
router.get("/related/:id", (req, res) => {
  const { id } = req.params;
  const query = `SELECT category, subcategory FROM products WHERE id = ?`;

  db.get(query, [id], (err, product) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const relatedQuery = `
      SELECT id, name, category, subcategory, images, price, rating
      FROM products
      WHERE category = ? AND subcategory = ? AND id != ?
      ORDER BY RANDOM()
      LIMIT 8
    `;

    db.all(relatedQuery, [product.category, product.subcategory, id], async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const enriched = await Promise.all(
        (rows || []).map(async (r) => {
          const images = (() => {
            if (!r.images) return [];
            try {
              const parsed = JSON.parse(r.images);
              return Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              return String(r.images).split(",").map((s) => s.trim()).filter(Boolean);
            }
          })();

          const sizesArr = await getSizesForProduct(r.id);
          const sizeStock = {};
          sizesArr.forEach((s) => {
            if (s && s.size) sizeStock[String(s.size)] = Number(s.stock || 0);
          });
          const totalStock = Object.values(sizeStock).reduce((acc, v) => acc + Number(v || 0), 0);

          return {
            ...r,
            id: Number(r.id),
            price: r.price !== null ? Number(r.price) : null,
            rating: r.rating !== null ? Number(r.rating) : null,
            images,
            sizes: sizesArr.map((s) => s.size),
            sizeStock,
            size_stock: JSON.stringify(sizeStock),
            totalStock,
          };
        })
      );

      res.json(enriched);
    });
  });
});

/* -------------------- GET SINGLE PRODUCT BY ID -------------------- */
router.get("/:id", (req, res) => {
  const { id } = req.params;
  const query = `SELECT * FROM products WHERE id = ?`;

  db.get(query, [id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Product not found" });

    // parse legacy fields
    const sizesFromField = parseField(row.sizes); // could be ["S","M"] or objects depending on DB
    const colors = parseField(row.colors);
    const images = parseField(row.images);

    // fetch product_sizes
    const sizesArr = await getSizesForProduct(row.id); // [{size,stock},...]
    const sizeStockMap = {};
    sizesArr.forEach((s) => {
      if (s && s.size) sizeStockMap[String(s.size)] = Number(s.stock || 0);
    });

    // If product_sizes is empty but row.sizes contains objects [{size,stock}] or "S:10" strings, try to derive
    if (sizesArr.length === 0 && Array.isArray(sizesFromField) && sizesFromField.length) {
      const fallbackMap = {};
      sizesFromField.forEach((it) => {
        if (!it) return;
        if (typeof it === "string") {
          const part = it.trim();
          if (part.includes(":") || part.includes("=")) {
            const [size, qty] = part.split(/[:=]/).map((s2) => s2 && s2.trim());
            if (size) fallbackMap[size] = Number(qty) || 0;
          } else {
            fallbackMap[part] = fallbackMap[part] || 0;
          }
        } else if (typeof it === "object") {
          const size = it.size ?? it.size_name ?? it.name ?? it.label;
          const qty = Number(it.stock ?? it.qty ?? it.quantity ?? 0) || 0;
          if (size) fallbackMap[size] = qty;
        }
      });
      Object.assign(sizeStockMap, fallbackMap);
    }

    const totalStock = Object.values(sizeStockMap).reduce((acc, v) => acc + Number(v || 0), 0);

    res.json({
      ...row,
      id: Number(row.id),
      sizes:
        Array.isArray(sizesFromField) &&
        sizesFromField.every((x) => typeof x === "string") &&
        sizesFromField.length
          ? sizesFromField
          : Object.keys(sizeStockMap),
      sizeRows: sizesArr,
      sizeStock: sizeStockMap, // object map (might be empty)
      size_stock: JSON.stringify(sizeStockMap),
      totalStock,
      colors,
      images,
      stock: Number(row.stock) || totalStock,
    });
  });
});

export default router;
