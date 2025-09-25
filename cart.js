// routes/cartRoutes.js
import express from "express";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_FILE || path.join(__dirname, "./dripzoid.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ Failed to connect to database:", err.message);
  else console.log("✅ Connected to SQLite at:", dbPath);
});

// Use env JWT secret if provided for flexibility
const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_KEY || "Dripzoid.App@2025";

// Middleware: JWT authentication
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) return res.sendStatus(401);

  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

/**
 * Utility: parseImagesField
 * Accepts possible shapes:
 *   - JSON array string: '["url1","url2"]'
 *   - comma-separated string: "url1,url2"
 *   - actual array
 *   - null/undefined
 * Returns an array of trimmed non-empty URLs.
 */
function parseImagesField(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (typeof raw !== "string") return [];

  const s = raw.trim();
  if (!s) return [];

  // try JSON parse first
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
  } catch {
    // ignore
  }

  // fallback to comma-separated
  return s
    .split(",")
    .map((p) => String(p || "").trim())
    .filter(Boolean);
}

/**
 * Utility: parseColorsField
 * Similar to parseImagesField (accepts JSON array string or CSV or array)
 * Returns normalized array of color strings.
 */
function parseColorsField(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((c) => String(c || "").trim()).filter(Boolean);
  if (typeof raw !== "string") return [];
  const s = raw.trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map((c) => String(c || "").trim()).filter(Boolean);
  } catch {
    // ignore
  }
  // fallback CSV (split by comma)
  return s
    .split(",")
    .map((c) => String(c || "").trim())
    .filter(Boolean);
}

/**
 * Helper: Map images to selected color based on product colors order.
 * Distribution strategy:
 *   - If images.length === colors.length: 1 image per color
 *   - Otherwise, compute base = Math.floor(nImgs / nColors), remainder = nImgs % nColors,
 *     then first `remainder` colors get (base + 1) images, remaining get base images.
 *   - This mirrors the approach in the frontend.
 * If selectedColor not found (case-insensitive), fallback to:
 *   - images for first color (if any) OR the entire images array.
 */
function getImagesForColor(images, colors = [], selectedColor) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (!Array.isArray(colors) || colors.length === 0) {
    // No color meta — return all images
    return images;
  }

  const nImgs = images.length;
  const nColors = colors.length;

  // compute counts per color (handles remainder)
  const base = Math.floor(nImgs / nColors);
  let remainder = nImgs % nColors;

  // build counts array where counts[i] = number of images for colors[i]
  const counts = new Array(nColors).fill(base).map((v, i) => {
    if (remainder > 0) {
      remainder -= 1;
      return v + 1;
    }
    return v;
  });

  // build index offsets by summing counts
  const offsets = [];
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    offsets.push(acc);
    acc += counts[i];
  }

  // find color index case-insensitively (trimmed)
  const target = (selectedColor || "").toString().trim().toLowerCase();
  const colorIndex = colors.findIndex((c) => String(c || "").trim().toLowerCase() === target);

  const idx = colorIndex >= 0 ? colorIndex : 0; // fallback to first color
  const start = offsets[idx] || 0;
  const count = counts[idx] || 0;

  // slice safely
  const end = Math.min(start + count, images.length);
  if (start >= images.length || count === 0) {
    // fallback to whole images
    return images.slice(0);
  }
  return images.slice(start, end);
}

/**
 * GET /api/cart
 * Returns cart items with product details and images filtered to selectedColor.
 */
router.get("/", authenticateToken, (req, res) => {
  const sql = `
    SELECT 
      cart_items.id AS cart_id,
      cart_items.product_id,
      cart_items.quantity, 
      cart_items.size AS selectedSize,
      cart_items.color AS selectedColor,
      products.name, 
      products.price, 
      products.images,
      products.colors,
      products.stock
    FROM cart_items
    JOIN products ON cart_items.product_id = products.id
    WHERE cart_items.user_id = ?
  `;

  db.all(sql, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const mapped = rows.map((row) => {
      // parse product images and colors robustly
      const images = parseImagesField(row.images);
      const colors = parseColorsField(row.colors);

      const imagesForSelected = getImagesForColor(images, colors, row.selectedColor);

      return {
        cart_id: row.cart_id,
        product_id: row.product_id,
        quantity: row.quantity,
        selectedSize: row.selectedSize,
        selectedColor: row.selectedColor,
        name: row.name,
        price: row.price,
        images: imagesForSelected,
        stock: row.stock,
      };
    });

    return res.json(mapped);
  });
});

// -------------------- Get cart items for a specific user --------------------
router.get("/:id", authenticateToken, (req, res) => {
  try {
    const requestedUserId = Number(req.params.id);
    const loggedInUserId = Number(req.user?.id);

    if (!requestedUserId) return res.status(400).json({ message: "Invalid user ID" });

    // Optional: Only allow users to fetch their own cart (or admin override if needed)
    if (requestedUserId !== loggedInUserId) {
      return res.status(403).json({ message: "Forbidden: Cannot access another user's cart" });
    }

    db.all(
      "SELECT c.id, c.product_id, c.quantity, p.name AS product_name, p.price FROM cart_items c LEFT JOIN products p ON c.product_id = p.id WHERE c.user_id = ?",
      [requestedUserId],
      (err, rows) => {
        if (err) {
          console.error("Fetch cart items error:", err);
          return res.status(500).json({ message: "Failed to fetch cart items" });
        }

        res.json({ cartItems: rows || [] });
      }
    );
  } catch (err) {
    console.error("GET /api/cart/:id error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


/**
 * POST /api/cart
 * Adds an item to the cart — validates product exists first
 */
router.post("/", authenticateToken, (req, res) => {
  const { product_id, quantity = 1, selectedSize = null, selectedColor = null } = req.body;

  if (!product_id) return res.status(400).json({ error: "Missing product_id" });

  db.get(`SELECT id FROM products WHERE id = ?`, [product_id], (err, productRow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!productRow) return res.status(400).json({ error: `Product not found: ${product_id}` });

    db.run(
      `INSERT INTO cart_items (user_id, product_id, size, color, quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, product_id, selectedSize, selectedColor, quantity],
      function (insertErr) {
        if (insertErr) return res.status(500).json({ error: insertErr.message });
        res.json({ id: this.lastID });
      }
    );
  });
});

/**
 * PUT /api/cart/:id
 * Updates quantity for a cart item
 */
router.put("/:id", authenticateToken, (req, res) => {
  const { quantity } = req.body;
  db.run(
    `UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?`,
    [quantity, req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ updated: this.changes });
    }
  );
});

/**
 * DELETE /api/cart/:id
 * Removes a cart item
 */
router.delete("/:id", authenticateToken, (req, res) => {
  db.run(
    `DELETE FROM cart_items WHERE id = ? AND user_id = ?`,
    [req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: this.changes });
    }
  );
});

export default router;



