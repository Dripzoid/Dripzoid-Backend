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

function buildShippingAddressFull(order = {}) {
  if (!order) return "";
  if (order.shipping_address && String(order.shipping_address).trim())
    return String(order.shipping_address).trim();

  const sj = order.shipping_json ?? order.shipping;
  if (!sj) return "";

  try {
    const payload = typeof sj === "string" ? JSON.parse(sj) : sj;
    if (!payload) return "";

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
  } catch (_) {
    try {
      const raw = String(sj).trim();
      if (raw.includes(",")) return raw;
      return raw;
    } catch (_) {}
  }
  return "";
}

function extractImageUrl(imagesField) {
  if (!imagesField) return null;

  try {
    const parsed = typeof imagesField === "string" ? JSON.parse(imagesField) : imagesField;
    if (Array.isArray(parsed) && parsed.length) {
      const first = parsed[0];
      if (!first) return null;
      return typeof first === "string" ? first : first.url ?? first.src ?? first.path ?? null;
    }
    if (parsed && typeof parsed === "object") return parsed.url ?? parsed.src ?? parsed.path ?? null;
  } catch (_) {
    if (typeof imagesField === "string" && imagesField.includes(",")) {
      const parts = imagesField.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[0];
    }
  }
  return null;
}

// ------------------ Promisified DB ------------------
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

// ------------------ Routes ------------------

// GET single order with items
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

    order.shipping_address_full = order.shipping_address || buildShippingAddressFull(order);

    const itemsSQL = `
      SELECT oi.*, p.name AS product_name, p.images
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
    `;
    const items = await dbAll(itemsSQL, [orderId]);

    const processedItems = (items || []).map((i) => ({
      product_id: i.product_id,
      name: i.product_name ?? i.name ?? null,
      quantity: Number(i.quantity) || 0,
      unit_price: i.unit_price ?? null,
      line_total: i.price ?? i.line_total ?? null,
      image_url: extractImageUrl(i.images),
      raw: i,
    }));

    res.json({ ...order, items: processedItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

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
      SELECT o.*, u.name AS customerName, COALESCE(o.shipping_address, '') AS shipping_address_full
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
      SELECT oi.order_id, oi.product_id, oi.quantity, oi.unit_price, oi.price AS line_total, p.name AS product_name, p.images, p.image
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (${placeholders})
    `;
    const items = await dbAll(itemsSQL, orderIds);

    const itemsMap = {};
    items.forEach(i => {
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

    const enrichedOrders = orders.map(o => ({
      ...o,
      shipping_address_full: o.shipping_address_full || buildShippingAddressFull(o),
      items: itemsMap[o.id] || [],
      customerName: o.customerName,
    }));

    res.json(enrichedOrders);
  } catch (err) {
    console.error(err);
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
    console.error(err);
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error", error: err.message });
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
      if (err) return res.status(500).json({ message: "Database error", error: err.message });
      res.json({ message: "Bulk status update complete", updatedRows: this.changes });
    });
  } catch (err) {
    console.error(err);
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
      if (err) return res.status(500).json({ message: "Database error", error: err.message });
      res.json({ message: "Order status updated", changes: this.changes });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

export default router;

