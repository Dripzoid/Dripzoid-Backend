// routes/userOrdersRoutes.js
import express from "express";
import db from "./db.js";
import { auth } from "./auth.js";
import PDFDocument from "pdfkit";

const router = express.Router();

/**
 * GET /api/user/orders
 * Fetch all orders for logged-in user (supports pagination, filtering, sorting)
 */
router.get("/", auth, (req, res) => {
  const userId = req.user.id;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const offset = (page - 1) * limit;

  // Filtering
  const statusFilter = req.query.status ? req.query.status.trim().toLowerCase() : null;

  // Sorting (only allow specific fields)
  const allowedSortFields = ["created_at", "status", "total_amount"];
  const sortField = allowedSortFields.includes(req.query.sort_by) ? req.query.sort_by : "created_at";

  // Sorting direction
  const sortDir = req.query.sort_dir && req.query.sort_dir.toUpperCase() === "ASC" ? "ASC" : "DESC";

  // Base SQL
  let sql = `
    SELECT o.id, o.status, o.total_amount, o.created_at,
           GROUP_CONCAT(p.name, ', ') AS products
    FROM orders o
    JOIN order_items oi ON o.id = oi.order_id
    JOIN products p ON oi.product_id = p.id
    WHERE o.user_id = ?
  `;

  // Add status filter if provided
  const params = [userId];
  if (statusFilter) {
    sql += " AND LOWER(o.status) = ?";
    params.push(statusFilter);
  }

  // Group & sort
  sql += `
    GROUP BY o.id
    ORDER BY ${sortField} ${sortDir}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error("Error fetching orders:", err);
      return res.status(500).json({ message: "Failed to fetch orders" });
    }
    res.json(rows);
  });
});

/**
 * PUT /api/user/orders/:id/cancel
 */
router.put("/:id/cancel", auth, (req, res) => {
  const userId = req.user.id;
  const orderId = req.params.id;

  const sql = `
    UPDATE orders
    SET status = 'cancelled'
    WHERE id = ? AND user_id = ? AND LOWER(status) IN ('pending','confirmed')
  `;

  db.run(sql, [orderId, userId], function (err) {
    if (err) {
      console.error("Error cancelling order:", err);
      return res.status(500).json({ message: "Failed to cancel order" });
    }
    if (this.changes === 0) {
      return res.status(400).json({ message: "Order cannot be cancelled" });
    }
    res.json({ message: "Order cancelled successfully" });
  });
});

/**
 * POST /api/user/orders/:id/reorder
 */
router.post("/:id/reorder", auth, async (req, res) => {
  const userId = req.user.id;
  const orderId = req.params.id;

  try {
    const oldOrder = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM orders WHERE id = ? AND user_id = ?", [orderId, userId], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });

    if (!oldOrder) {
      return res.status(404).json({ message: "Order not found" });
    }

    const oldItems = await new Promise((resolve, reject) => {
      db.all("SELECT * FROM order_items WHERE order_id = ?", [orderId], (err, rows) =>
        err ? reject(err) : resolve(rows)
      );
    });

    if (oldItems.length === 0) {
      return res.status(400).json({ message: "No items to reorder" });
    }

    const newOrderId = await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO orders (user_id, total_amount, status, created_at, payment_method) VALUES (?, ?, 'Pending', datetime('now'), ?)",
        [userId, oldOrder.total_amount, oldOrder.payment_method],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    for (const item of oldItems) {
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)",
          [newOrderId, item.product_id, item.quantity, item.price],
          (err) => (err ? reject(err) : resolve())
        );
      });
    }

    const updatedOrders = await new Promise((resolve, reject) => {
      db.all(
        `SELECT o.id, o.status, o.total_amount, o.created_at,
                GROUP_CONCAT(p.name, ', ') AS products
         FROM orders o
         JOIN order_items oi ON o.id = oi.order_id
         JOIN products p ON oi.product_id = p.id
         WHERE o.user_id = ?
         GROUP BY o.id
         ORDER BY o.created_at DESC`,
        [userId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    res.json({ message: "Reorder placed successfully", newOrderId, orders: updatedOrders });
  } catch (err) {
    console.error("Error in reorder:", err);
    res.status(500).json({ message: "Failed to reorder" });
  }
});

/**
 * GET /api/user/orders/:id/invoice
 */
router.get("/:id/invoice", auth, async (req, res) => {
  const userId = req.user.id;
  const orderId = req.params.id;

  const dbGet = (sql, params) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  const dbAll = (sql, params) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ? AND user_id = ?", [orderId, userId]);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const items = await dbAll(
      `SELECT p.name, oi.quantity, oi.price
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=invoice-${orderId}.pdf`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    doc.fontSize(18).text("Invoice", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Order ID: ${orderId}`);
    doc.text(`Date: ${order.created_at}`);
    doc.text(`Status: ${order.status}`);
    if (order.payment_method) doc.text(`Payment Method: ${order.payment_method}`);
    doc.moveDown();

    doc.fontSize(14).text("Items:");
    doc.moveDown(0.5);
    doc.fontSize(12);

    let computed = 0;
    items.forEach((it) => {
      const line = Number(it.price || 0) * Number(it.quantity || 0);
      computed += line;
      doc.text(`${it.name} — Qty: ${it.quantity} × ₹${Number(it.price).toLocaleString()} = ₹${line.toLocaleString()}`);
    });

    doc.moveDown();
    doc.fontSize(12).text(`Subtotal (from items): ₹${computed.toLocaleString()}`);
    doc.fontSize(14).text(`Total (order): ₹${Number(order.total_amount).toLocaleString()}`, { align: "right" });

    doc.end();
  } catch (err) {
    console.error("Error generating invoice:", err);
    res.status(500).json({ message: "Failed to generate invoice" });
  }
});

// ✅ Verify if user purchased a product (for review eligibility)
router.get("/verify", (req, res) => {
  const { productId, userId } = req.query;

  if (!productId || !userId) {
    return res.status(400).json({ error: "Missing productId or userId" });
  }

  const sql = `
  SELECT COUNT(*) as count
  FROM order_items oi
  JOIN orders o ON oi.order_id = o.id
  WHERE oi.product_id = ? AND o.user_id = ? AND LOWER(o.status) = 'delivered'
`;


  db.get(sql, [productId, userId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    res.json({ canReview: row.count > 0 });
  });
});

export default router;



