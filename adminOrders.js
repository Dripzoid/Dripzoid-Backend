// routes/adminOrders.js
import express from "express";
import db from "./db.js";
import authMiddleware from "./authAdmin.js";

const router = express.Router();

const DEFAULT_LIMIT = 50;
const isIntegerString = (s) => /^-?\d+$/.test(String(s));
const sanitizeSortBy = (s) => {
  const allowed = new Set(["expected_delivery_from", "expected_delivery_to", "created_at", "id"]);
  return allowed.has(s) ? s : "created_at";
};
const sanitizeSortOrder = (o) =>
  ["ASC", "DESC"].includes(String(o).toUpperCase()) ? String(o).toUpperCase() : "ASC";

/**
 * Helper: build a human-friendly shipping address string
 * from shipping_address field or shipping_json (if available).
 */
function buildShippingAddressFull(order = {}) {
  if (!order) return "";
  if (order.shipping_address && String(order.shipping_address).trim()) return String(order.shipping_address).trim();

  const sj = order.shipping_json ?? order.shipping; // some rows might use shipping
  if (!sj) return "";

  try {
    const payload = typeof sj === "string" ? JSON.parse(sj) : sj;
    if (!payload) return "";

    // If payload is a plain string (rare), return it
    if (typeof payload === "string" && payload.trim()) return payload.trim();

    const parts = [];
    if (payload.name) parts.push(String(payload.name).trim());
    if (payload.address) parts.push(String(payload.address).trim());
    const cityState = [payload.city, payload.state].filter(Boolean).join(", ");
    if (cityState) parts.push(cityState);
    const pin = payload.pincode ?? payload.postal ?? payload.zip;
    if (pin) parts.push(String(pin).trim());
    if (payload.country) parts.push(String(payload.country).trim());
    const phone = payload.phone ?? payload.mobile;
    if (phone) parts.push("Phone: " + String(phone).trim());
    if (parts.length) return parts.join(", ");
  } catch (e) {
    // not JSON — maybe comma-separated or raw string
    try {
      const raw = String(sj).trim();
      if (raw.includes(",")) return raw;
      return raw;
    } catch (ignore) {}
  }
  return "";
}

/**
 * Helper: derive a single image URL from various product image shapes.
 * Accepts:
 *  - JSON array string (["url1","url2"]) or [{url:...}, ...]
 *  - comma-separated string
 *  - single URL string
 */
function extractImageUrl(imagesField, productRow = {}) {
  if (!imagesField && (productRow.image || productRow.thumbnail)) {
    return productRow.image || productRow.thumbnail;
  }

  if (!imagesField) return null;

  // Already a URL
  if (typeof imagesField === "string" && /^https?:\/\//i.test(imagesField.trim())) {
    return imagesField.trim();
  }

  // Try JSON parse
  try {
    const parsed = typeof imagesField === "string" ? JSON.parse(imagesField) : imagesField;
    if (Array.isArray(parsed) && parsed.length) {
      // element could be string or object
      const first = parsed[0];
      if (!first) return null;
      if (typeof first === "string") return first;
      if (typeof first === "object") return first.url ?? first.src ?? first.path ?? null;
    }
    // if parsed is object with url
    if (parsed && typeof parsed === "object") {
      return parsed.url ?? parsed.src ?? parsed.path ?? null;
    }
  } catch (e) {
    // not JSON — try comma separated
    if (typeof imagesField === "string" && imagesField.includes(",")) {
      const parts = imagesField.split(",").map(s => s.trim()).filter(Boolean);
      if (parts.length && /^https?:\/\//i.test(parts[0])) return parts[0];
    }
  }

  return null;
}

/**
 * GET /api/admin/orders/labels
 * (placed before param route so "labels" doesn't get consumed by :id)
 */
router.get("/labels", authMiddleware, (req, res) => {
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
    SELECT o.*, u.name AS customerName, COALESCE(o.shipping_address, '') AS shipping_address_full
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ${whereSQL}
    ORDER BY ${safeSortBy} ${safeSortOrder}
  `;

  db.all(sql, params, (err, orders) => {
    if (err) return res.status(500).json({ message: "Database error", error: err.message });

    const orderIds = orders.map((o) => o.id);
    if (orderIds.length === 0) return res.json([]);

    const placeholders = orderIds.map(() => "?").join(",");
    const itemsSQL = `
      SELECT oi.order_id, oi.product_id, oi.quantity, oi.unit_price, oi.price AS line_total, p.name AS product_name, p.images, p.image
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (${placeholders})
    `;

    db.all(itemsSQL, orderIds, (err, items) => {
      if (err) return res.status(500).json({ message: "Database error", error: err.message });

      const itemsMap = {};
      items.forEach((i) => {
        if (!itemsMap[i.order_id]) itemsMap[i.order_id] = [];
        const image_url = extractImageUrl(i.images, i) || null;
        itemsMap[i.order_id].push({
          product_id: i.product_id,
          name: i.product_name ?? i.name,
          qty: i.quantity,
          unit_price: i.unit_price,
          line_total: i.line_total,
          image_url,
        });
      });

      const enrichedOrders = orders.map((o) => ({
        ...o,
        // prefer shipping_address_full, otherwise build from shipping_json
        shipping_address_full: o.shipping_address_full || buildShippingAddressFull(o),
        items: itemsMap[o.id] || [],
        customerName: o.customerName,
      }));

      res.json(enrichedOrders);
    });
  });
});

/**
 * GET /api/admin/orders/search
 * (also placed before param route)
 */
router.get("/search", authMiddleware, (req, res) => {
  const { query } = req.query;
  if (!query) return res.json([]);

  let sql;
  let params;
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

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json(rows);
  });
});

/**
 * GET /api/admin/orders
 * Paginated orders list with filters
 */
router.get("/", authMiddleware, (req, res) => {
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

  // Count query
  const countSql = `
    SELECT COUNT(DISTINCT o.id) AS total
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ${whereSQL}
  `;

  db.get(countSql, params, (err, countRow) => {
    if (err) return res.status(500).json({ message: "Database error", error: err.message });

    const total = countRow?.total || 0;
    // default limit if not provided
    const numericLimit =
      typeof limit !== "undefined" && limit !== "all"
        ? parseInt(limit, 10)
        : limit === "all"
          ? null
          : DEFAULT_LIMIT;
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

    db.all(sql, queryParams, (err, rows) => {
      if (err) return res.status(500).json({ message: "Database error", error: err.message });

      // attach shipping_address_full for frontend convenience
      const processedRows = (rows || []).map(r => ({
        ...r,
        shipping_address_full: r.shipping_address || buildShippingAddressFull(r),
      }));

      res.json({
        data: processedRows,
        total,
        page: pageNum,
        totalPages,
        hasPrev: pageNum > 1,
        hasNext: numericLimit ? pageNum < totalPages : false,
      });
    });
  });
});

/**
 * GET /api/admin/orders/:id
 * Fetch single order with items
 *
 * NOTE: must come after the specific routes above (labels/search)
 */
router.get("/:id", authMiddleware, (req, res) => {
  const orderId = req.params.id;

  const orderSQL = `
    SELECT o.*, u.name AS user_name
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id = ?
  `;
  const itemsSQL = `
    SELECT oi.*, p.name AS product_name, p.images, p.image
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `;

  db.get(orderSQL, [orderId], (err, order) => {
    if (err) return res.status(500).json({ message: "Database error", error: err.message });
    if (!order) return res.status(404).json({ message: "Order not found" });

    // build shipping_address_full for easy client rendering
    order.shipping_address_full = order.shipping_address || buildShippingAddressFull(order);

    db.all(itemsSQL, [orderId], (err, items) => {
      if (err) return res.status(500).json({ message: "Database error", error: err.message });

      const processed = (items || []).map(i => {
        const image_url = extractImageUrl(i.images, i) || null;
        return {
          product_id: i.product_id,
          name: i.product_name ?? i.name,
          quantity: i.quantity,
          unit_price: i.unit_price ?? null,
          line_total: i.price ?? i.line_total ?? null,
          image_url,
          raw: i, // keep raw in case frontend needs other fields
        };
      });

      res.json({ ...order, items: processed });
    });
  });
});

/**
 * PUT /api/admin/orders/bulk-update
 */
router.put("/bulk-update", authMiddleware, (req, res) => {
  const { orderIds, status } = req.body;
  if (!Array.isArray(orderIds) || orderIds.length === 0 || !status) {
    return res.status(400).json({ message: "orderIds array and status are required" });
  }

  const placeholders = orderIds.map(() => "?").join(",");
  const sql = `UPDATE orders SET status = ? WHERE id IN (${placeholders})`;

  db.run(sql, [status, ...orderIds], function (err) {
    if (err) return res.status(500).json({ message: "Database error", error: err.message });
    res.json({ message: "Bulk status update complete", updatedRows: this.changes });
  });
});

/**
 * PUT /api/admin/orders/:id
 */
router.put("/:id", authMiddleware, (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;
  if (!status) return res.status(400).json({ message: "Status is required" });

  db.run(`UPDATE orders SET status = ? WHERE id = ?`, [status, orderId], function (err) {
    if (err) return res.status(500).json({ message: "Database error", error: err.message });
    res.json({ message: "Order status updated", changes: this.changes });
  });
});

export default router;
