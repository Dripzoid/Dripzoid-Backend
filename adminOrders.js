// routes/adminOrders.js
import express from "express";
import db from "./db.js";
import authMiddleware from "./authAdmin.js";

const router = express.Router();
const DEFAULT_LIMIT = 50;

// ------------------ Helpers ------------------
const isIntegerString = (s) => /^-?\d+$/.test(String(s));

const sanitizeSortBy = (s) => {
  const allowed = new Set(["expected_delivery_from", "expected_delivery_to", "created_at", "id"]);
  return allowed.has(s) ? s : "created_at";
};

const sanitizeSortOrder = (o) =>
  ["ASC", "DESC"].includes(String(o).toUpperCase()) ? String(o).toUpperCase() : "ASC";

/**
 * Parse a shipping payload which may be:
 *  - a JSON string
 *  - an object
 *  - a plain text string
 *
 * Return an object with normalized fields we may use:
 * { name, street, village, locality, city, state, pincode, country, phone }
 */
function normalizeShippingPayload(raw) {
  if (!raw) return null;

  let payload = raw;
  if (typeof raw === "string") {
    // If it's a JSON string, parse it
    try {
      payload = JSON.parse(raw);
    } catch {
      // not JSON: treat as plain string
      const plain = String(raw || "").trim();
      if (!plain) return null;
      // attempt to split into parts heuristically
      const parts = plain.split(",").map(p => p.trim()).filter(Boolean);
      const [street = "", village = "", locality = "", city = "", state = "", pincode = "", country = ""] = parts;
      return {
        name: null,
        street: street || null,
        village: village || null,
        locality: locality || city || null,
        city: city || null,
        state: state || null,
        pincode: pincode || null,
        country: country || null,
        phone: null,
      };
    }
  }

  if (typeof payload !== "object" || payload === null) return null;

  // Map common field names to normalized fields
  const name = payload.name ?? payload.fullname ?? payload.customer_name ?? null;
  const street = payload.address ?? payload.street ?? payload.line1 ?? null;
  // some payloads contain village/locality fields
  const village = payload.village ?? payload.locality ?? payload.neighborhood ?? null;
  // city/locality
  const city = payload.city ?? payload.town ?? payload.city_name ?? payload.locality ?? null;
  const locality = payload.locality ?? payload.area ?? null;
  const state = payload.state ?? payload.region ?? null;
  const pincode = payload.pincode ?? payload.postal ?? payload.zip ?? null;
  const country = payload.country ?? null;
  const phone = payload.phone ?? payload.mobile ?? payload.contact ?? null;

  return {
    name: name || null,
    street: street || null,
    village: village || null,
    locality: locality || null,
    city: city || null,
    state: state || null,
    pincode: pincode || null,
    country: country || null,
    phone: phone || null,
  };
}

/**
 * Build a human-friendly shipping address string.
 * Order: [name] street, village, locality/city, state, pincode, country, Phone: <phone>
 */
function buildShippingAddressFull(order = {}) {
  if (!order) return "";

  // Prefer shipping_json if present, otherwise shipping_address if present (which may be JSON string)
  const raw = order.shipping_json ?? order.shipping_address ?? order.shipping ?? null;
  if (!raw) return "";

  const normalized = normalizeShippingPayload(raw);
  if (!normalized) {
    // If normalization failed, return trimmed raw string (avoid returning JSON stringified form)
    try {
      const s = String(raw).trim();
      return s;
    } catch {
      return "";
    }
  }

  const parts = [];
  // optionally include name at the start (e.g., "Work — John Doe")
  if (normalized.name) parts.push(String(normalized.name).trim());

  // street then village
  if (normalized.street) parts.push(String(normalized.street).trim());
  if (normalized.village) parts.push(String(normalized.village).trim());

  // locality or city (prefer locality if present)
  if (normalized.locality) parts.push(String(normalized.locality).trim());
  else if (normalized.city) parts.push(String(normalized.city).trim());

  // state
  if (normalized.state) parts.push(String(normalized.state).trim());

  // pincode
  if (normalized.pincode) parts.push(String(normalized.pincode).trim());

  // country
  if (normalized.country) parts.push(String(normalized.country).trim());

  let address = parts.filter(Boolean).join(", ");
  if (normalized.phone) {
    const phone = String(normalized.phone).trim();
    address = address ? `${address}, Phone: ${phone}` : `Phone: ${phone}`;
  }

  return address || "";
}

/**
 * Extract a single image URL (the first valid one) from different shapes:
 *  - JSON array string: '["url1","url2"]'
 *  - JSON array of objects: '[{ "url": "..."}]'
 *  - comma-separated string possibly containing newlines
 *  - single URL string
 *  - object with url/src/path properties
 *
 * Returns null if no valid URL found.
 */
function extractImageUrl(imagesField) {
  if (!imagesField) return null;

  // If it's already an object with url/src/path
  if (typeof imagesField === "object" && !Array.isArray(imagesField)) {
    return imagesField.url ?? imagesField.src ?? imagesField.path ?? null;
  }

  // If it's a string, normalize newlines and whitespace
  if (typeof imagesField === "string") {
    const raw = imagesField.trim();

    // If it's a single valid URL, return it
    if (/^https?:\/\//i.test(raw)) {
      // If there are newlines/commas inside the string we still handle below
      if (!raw.includes(",") && !/[\r\n]/.test(raw)) return raw;
    }

    // Try parse as JSON (array or object)
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        const first = parsed[0];
        if (typeof first === "string" && /^https?:\/\//i.test(first.trim())) return first.trim();
        if (typeof first === "object") return first.url ?? first.src ?? first.path ?? null;
      }
      if (parsed && typeof parsed === "object") {
        return parsed.url ?? parsed.src ?? parsed.path ?? null;
      }
    } catch (_) {
      // not JSON - fallthrough to comma/newline splitting
    }

    // Handle comma-separated with possible newlines
    if (raw.includes(",") || /[\r\n]/.test(raw)) {
      const parts = raw
        .split(/[,|\n|\r]+/) // split on comma or newline (handles both)
        .map(s => s.replace(/[\r\n]+/g, "").trim()) // remove stray newlines and trim
        .filter(Boolean);

      for (const p of parts) {
        if (/^https?:\/\//i.test(p)) return p;
      }
      return null;
    }

    // Last attempt: if trimmed string is a URL-like
    if (/^https?:\/\//i.test(raw)) return raw;
    return null;
  }

  return null;
}

// ------------------ Promisified DB helpers ------------------
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// ------------------ Routes ------------------

// GET /api/admin/orders/labels
router.get("/labels", authMiddleware, async (req, res) => {
  try {
    const { orderId, status, startDate, endDate, sortBy, sortOrder } = req.query;

    let whereClauses = [];
    let params = [];

    if (orderId) {
      whereClauses.push("o.id = ?");
      params.push(isIntegerString(orderId) ? Number(orderId) : orderId);
    }
    if (status) {
      whereClauses.push("LOWER(o.status) = LOWER(?)");
      params.push(status);
    }
    if (startDate && endDate) {
      whereClauses.push("DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)");
      params.push(startDate, endDate);
    }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const safeSortBy = sanitizeSortBy(sortBy || "created_at");
    const safeSortOrder = sanitizeSortOrder(sortOrder || "ASC");

    const sql = `
      SELECT o.*, u.name AS customerName, COALESCE(o.shipping_address, '') AS shipping_address_raw
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      ${whereSQL}
      ORDER BY ${safeSortBy} ${safeSortOrder}
    `;
    const orders = await dbAll(sql, params);

    if (!orders.length) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const itemsSQL = `
      SELECT oi.order_id, oi.product_id, oi.quantity, oi.unit_price, oi.price AS line_total, p.name AS product_name, p.images
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (${placeholders})
    `;
    const items = await dbAll(itemsSQL, orderIds);

    const itemsMap = {};
    items.forEach(i => {
      if (!itemsMap[i.order_id]) itemsMap[i.order_id] = [];
      const image_url = extractImageUrl(i.images) || null;
      itemsMap[i.order_id].push({
        product_id: i.product_id,
        name: i.product_name ?? i.name,
        qty: i.quantity,
        unit_price: i.unit_price,
        line_total: i.line_total,
        image_url,
      });
    });

    const enrichedOrders = orders.map(o => {
      const shippingSource = o.shipping_address_raw ?? o.shipping_json ?? null;
      return {
        ...o,
        shipping_address_full: buildShippingAddressFull({ shipping_address: shippingSource, shipping_json: null }),
        items: itemsMap[o.id] || [],
        customerName: o.customerName,
      };
    });

    res.json(enrichedOrders);
  } catch (err) {
    console.error("GET /labels error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

// GET /api/admin/orders/search
router.get("/search", authMiddleware, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.json([]);

    let sql, params;
    if (isIntegerString(query)) {
      sql = `
        SELECT o.id, u.name AS customerName
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.id = ? OR LOWER(u.name) LIKE LOWER(?)
        LIMIT 10
      `;
      params = [Number(query), `%${query}%`];
    } else {
      sql = `
        SELECT o.id, u.name AS customerName
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE LOWER(u.name) LIKE LOWER(?)
        LIMIT 10
      `;
      params = [`%${query}%`];
    }

    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("GET /search error:", err);
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/orders
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status, search, orderId, startDate, endDate, page = 1, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    let whereClauses = [];
    let params = [];

    if (orderId) {
      whereClauses.push("o.id = ?");
      params.push(Number(orderId));
    } else if (search) {
      if (/^\d+$/.test(search)) {
        whereClauses.push("(u.id = ? OR LOWER(u.name) LIKE LOWER(?))");
        params.push(Number(search), `%${search}%`);
      } else {
        whereClauses.push("LOWER(u.name) LIKE LOWER(?)");
        params.push(`%${search}%`);
      }
    }

    if (status) {
      whereClauses.push("LOWER(o.status) = LOWER(?)");
      params.push(status);
    }

    if (startDate && endDate) {
      whereClauses.push("DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)");
      params.push(startDate, endDate);
    }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const countSql = `
      SELECT COUNT(DISTINCT o.id) AS total
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      ${whereSQL}
    `;
    const countRow = await dbGet(countSql, params);
    const total = countRow?.total || 0;
    const numericLimit = limit && limit !== "all" ? parseInt(limit, 10) : limit === "all" ? null : DEFAULT_LIMIT;
    const totalPages = numericLimit ? Math.ceil(total / numericLimit) : 1;

    let sql = `
      SELECT o.*, u.name AS user_name, u.phone AS user_phone, COUNT(oi.id) AS items_count
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${whereSQL}
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `;

    const queryParams = [...params];
    if (numericLimit) {
      const offset = (pageNum - 1) * numericLimit;
      sql += ` LIMIT ? OFFSET ?`;
      queryParams.push(numericLimit, offset);
    }

    const rows = await dbAll(sql, queryParams);
    const processedRows = rows.map(r => ({
      ...r,
      shipping_address_full: buildShippingAddressFull(r),
    }));

    res.json({
      data: processedRows,
      total,
      page: pageNum,
      totalPages,
      hasPrev: pageNum > 1,
      hasNext: numericLimit ? pageNum < totalPages : false,
    });
  } catch (err) {
    console.error("GET / error:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
});

// GET /api/admin/orders/:id
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!orderId) return res.status(400).json({ message: "Order ID required" });

    const orderSQL = `
      SELECT o.*, u.name AS user_name
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.id = ?
    `;
    const order = await dbGet(orderSQL, [orderId]);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Build a nicely formatted shipping address
    order.shipping_address_full = buildShippingAddressFull(order);

    const itemsSQL = `
      SELECT oi.*, p.name AS product_name, p.images
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
    `;
    const items = await dbAll(itemsSQL, [orderId]);

    const processedItems = (items || []).map(i => {
      const image_url = extractImageUrl(i.images) || null;
      return {
        product_id: i.product_id,
        name: i.product_name ?? i.name ?? null,
        quantity: Number(i.quantity) || 0,
        unit_price: typeof i.unit_price !== "undefined" ? i.unit_price : null,
        line_total: i.price ?? i.line_total ?? null,
        image_url,
        raw: i,
      };
    });

    res.json({ ...order, items: processedItems });
  } catch (err) {
    console.error("GET /:id error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

// PUT /api/admin/orders/bulk-update
router.put("/bulk-update", authMiddleware, async (req, res) => {
  try {
    const { orderIds, status } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length || !status) {
      return res.status(400).json({ message: "orderIds array and status are required" });
    }

    const placeholders = orderIds.map(() => "?").join(",");
    const sql = `UPDATE orders SET status = ? WHERE id IN (${placeholders})`;

    db.run(sql, [status, ...orderIds], function (err) {
      if (err) {
        console.error("bulk-update db.run error:", err);
        return res.status(500).json({ message: "Database error", error: err.message });
      }
      res.json({ message: "Bulk status update complete", updatedRows: this.changes });
    });
  } catch (err) {
    console.error("PUT /bulk-update error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

// PUT /api/admin/orders/:id
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const orderId = req.params.id;
    if (!status) return res.status(400).json({ message: "Status is required" });

    db.run(`UPDATE orders SET status = ? WHERE id = ?`, [status, orderId], function (err) {
      if (err) {
        console.error("PUT /:id db.run error:", err);
        return res.status(500).json({ message: "Database error", error: err.message });
      }
      res.json({ message: "Order status updated", changes: this.changes });
    });
  } catch (err) {
    console.error("PUT /:id error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

export default router;
