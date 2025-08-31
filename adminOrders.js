import express from "express";
import db from "../db.js";
import authMiddleware from "../middleware/authAdmin.js";

const router = express.Router();

const DEFAULT_LIMIT = 50;
const isIntegerString = (s) => /^-?\d+$/.test(String(s));
const sanitizeSortBy = (s) => {
  const allowed = new Set([
    "delivery_date",
    "expected_delivery_from",
    "created_at",
    "id",
  ]);
  return allowed.has(s) ? s : "delivery_date";
};
const sanitizeSortOrder = (o) =>
  ["ASC", "DESC"].includes(String(o).toUpperCase())
    ? String(o).toUpperCase()
    : "ASC";

router.get("/", authMiddleware, (req, res) => {
  const { status, search, orderId, deliveryDate, startDate, endDate, page = 1, limit } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);

  let whereClauses = [];
  let params = [];

  if (orderId) {
    whereClauses.push("o.id = ?");
    params.push(Number(orderId));
  } else if (search) {
    if (/^\d+$/.test(search)) {
      // numeric search fallback: user_id or name
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

  if (deliveryDate) {
    whereClauses.push("(DATE(o.expected_delivery_from) = DATE(?) OR DATE(o.delivery_date) = DATE(?))");
    params.push(deliveryDate, deliveryDate);
  }

  if (startDate && endDate) {
    whereClauses.push(
      "(DATE(o.expected_delivery_from) BETWEEN DATE(?) AND DATE(?) OR DATE(o.delivery_date) BETWEEN DATE(?) AND DATE(?))"
    );
    params.push(startDate, endDate, startDate, endDate);
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
    SELECT o.*, u.name AS user_name,
      COALESCE(
        o.shipping_address,
        o.address_line1 || ', ' || o.address_line2 || ', ' || o.city || ', ' || o.state || ' - ' || o.pincode || ', ' || o.country || ' Phone: ' || o.phone,
        ''
      ) AS shipping_address_full
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
    if (err)
      return res.status(500).json({ message: "Database error", error: err.message });
    if (!order) return res.status(404).json({ message: "Order not found" });

    db.all(itemsSQL, [orderId], (err, items) => {
      if (err)
        return res.status(500).json({ message: "Database error", error: err.message });
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
    if (err)
      return res.status(500).json({ message: "Database error", error: err.message });
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
    if (err)
      return res.status(500).json({ message: "Database error", error: err.message });
    res.json({ message: "Order status updated", changes: this.changes });
  });
});

/**
 * GET /api/admin/orders/labels
 * Now supports orderId, status, deliveryDate, and date range filters
 */
router.get("/labels", authMiddleware, (req, res) => {
  const { orderId, status, deliveryDate, startDate, endDate, sortBy, sortOrder } =
    req.query;

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
  if (deliveryDate) {
    whereClauses.push("DATE(o.delivery_date) = DATE(?)");
    params.push(deliveryDate);
  }
  if (startDate && endDate) {
    whereClauses.push("DATE(o.delivery_date) BETWEEN DATE(?) AND DATE(?)");
    params.push(startDate, endDate);
  }

  const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // sanitize sort params to prevent injection
  const safeSortBy = sanitizeSortBy(sortBy || "delivery_date");
  const safeSortOrder = sanitizeSortOrder(sortOrder || "ASC");

  const sql = `
    SELECT o.*, u.name AS customerName,
      COALESCE(o.shipping_address, '') AS shipping_address_full,
      COALESCE(o.address_line1, '') AS addressLine1,
      COALESCE(o.address_line2, '') AS addressLine2,
      COALESCE(o.city, '') AS city,
      COALESCE(o.state, '') AS state,
      COALESCE(o.pincode, '') AS pincode,
      COALESCE(o.country, '') AS country,
      COALESCE(o.phone, '') AS phone,
      COALESCE(o.barcode, '') AS barcode
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ${whereSQL}
    ORDER BY ${safeSortBy} ${safeSortOrder}
  `;

  db.all(sql, params, (err, orders) => {
    if (err)
      return res.status(500).json({ message: "Database error", error: err.message });

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
      if (err)
        return res.status(500).json({ message: "Database error", error: err.message });

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
 * POST /api/admin/orders/labels/zpl-batch
 */
router.post("/labels/zpl-batch", authMiddleware, (req, res) => {
  const { orderIds } = req.body;
  if (!Array.isArray(orderIds) || orderIds.length === 0)
    return res.status(400).json({ message: "Provide orderIds array" });

  const placeholders = orderIds.map(() => "?").join(",");
  // join users so we have customer name reliably
  const sql = `
    SELECT o.id, o.barcode, u.name AS customerName, o.address_line1, o.city, o.state, o.pincode
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id IN (${placeholders})
  `;
  db.all(sql, orderIds, (err, rows) => {
    if (err) return res.status(500).json({ message: err.message });

    let zpl = "";
    rows.forEach((o) => {
      zpl += `^XA\n^FO20,20^FDOrder: ${o.id}^FS\n^FO20,60^BCN,80,Y,N,N^FD${o.barcode || ""}^FS\n^FO20,150^FD${o.customerName || ""}, ${o.address_line1 || ""}, ${o.city || ""}, ${o.state || ""} ${o.pincode || ""}^FS\n^XZ\n`;
    });

    res.setHeader("Content-Disposition", "attachment; filename=labels.zpl");
    res.setHeader("Content-Type", "text/plain");
    res.send(zpl);
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
      SELECT id, barcode, name AS customerName
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.id = ? OR LOWER(u.name) LIKE LOWER(?)
      LIMIT 10
    `;
    params = [Number(query), `%${query}%`];
  } else {
    sql = `
      SELECT id, barcode, name AS customerName
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
