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
    const numericLimit = limit && limit !== "all" ? parseInt(limit, 10) : null;
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

    let queryParams = [...params];
    if (numericLimit) {
      const offset = (pageNum - 1) * numericLimit;
      sql += ` LIMIT ? OFFSET ?`;
      queryParams.push(numericLimit, offset);
    }

    db.all(sql, queryParams, (err, rows) => {
      if (err) return res.status(500).json({ message: "Database error", error: err.message });

      res.json({
        data: rows,
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
    SELECT oi.*, p.name, p.images
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `;

  db.get(orderSQL, [orderId], (err, order) => {
    if (err) return res.status(500).json({ message: "Database error", error: err.message });
    if (!order) return res.status(404).json({ message: "Order not found" });

    db.all(itemsSQL, [orderId], (err, items) => {
      if (err) return res.status(500).json({ message: "Database error", error: err.message });
      res.json({ ...order, items });
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

/**
 * GET /api/admin/orders/labels
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
      SELECT oi.*, p.name
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (${placeholders})
    `;

    db.all(itemsSQL, orderIds, (err, items) => {
      if (err) return res.status(500).json({ message: "Database error", error: err.message });

      const itemsMap = {};
      items.forEach((i) => {
        if (!itemsMap[i.order_id]) itemsMap[i.order_id] = [];
        itemsMap[i.order_id].push({ name: i.name, qty: i.quantity });
      });

      const enrichedOrders = orders.map((o) => ({
        ...o,
        items: itemsMap[o.id] || [],
        customerName: o.customerName,
      }));

      res.json(enrichedOrders);
    });
  });
});

/**
 * GET /api/admin/orders/search
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

export default router;
