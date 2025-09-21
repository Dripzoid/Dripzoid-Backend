// routes/userOrdersRoutes.js
import express from "express";
import db from "./db.js";
import { auth } from "./auth.js";
import PDFDocument from "pdfkit";

const router = express.Router();

router.get("/", auth, (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);
    const offset = (page - 1) * limit;

    // Filtering
    const statusFilter = req.query.status ? req.query.status.trim().toLowerCase() : null;

    // Sorting
    const allowedSortFields = ["created_at", "status", "total_amount"];
    const sortField = allowedSortFields.includes(req.query.sort_by)
      ? `o.${req.query.sort_by}`
      : "o.created_at";
    const sortDir = req.query.sort_dir?.toUpperCase() === "ASC" ? "ASC" : "DESC";

    // Base WHERE clause
    let baseWhere = "WHERE o.user_id = ?";
    const baseParams = [userId];
    if (statusFilter) {
      baseWhere += " AND LOWER(o.status) = ?";
      baseParams.push(statusFilter);
    }

    // Count total for pagination
    const countSql = `
      SELECT COUNT(DISTINCT o.id) AS total
      FROM orders o
      LEFT JOIN addresses a ON o.address_id = a.id
      ${baseWhere}
    `;
    db.get(countSql, baseParams, (countErr, countRow) => {
      if (countErr) {
        console.error("Error counting orders:", countErr);
        return res.status(500).json({ message: "Failed to fetch orders count" });
      }

      const total = Number(countRow?.total ?? 0);
      if (total === 0) {
        return res.json({ data: [], meta: { total: 0, page, pages: 1, limit } });
      }

      // Fetch paginated orders with users + addresses
      const selectSql = `
        SELECT 
          o.*,
          u.name AS user_name,
          a.id AS addr_id,
          a.label AS addr_label,
          a.line1 AS addr_line1,
          a.line2 AS addr_line2,
          a.city AS addr_city,
          a.state AS addr_state,
          a.pincode AS addr_pincode,
          a.country AS addr_country,
          a.phone AS addr_phone
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        LEFT JOIN addresses a ON o.address_id = a.id
        ${baseWhere}
        ORDER BY ${sortField} ${sortDir}
        LIMIT ? OFFSET ?
      `;
      const selectParams = [...baseParams, limit, offset];

      db.all(selectSql, selectParams, (selErr, orders) => {
        if (selErr) {
          console.error("Error fetching orders:", selErr);
          return res.status(500).json({ message: "Failed to fetch orders" });
        }

        const orderIds = orders.map(o => o.id).filter(v => v != null);
        const itemsByOrder = {};

        const fetchItemsAndRespond = () => {
          const result = orders.map(orderRow => {
            // 1️⃣ Prefer canonical address table
            let shippingAddress = null;
            if (orderRow.addr_id) {
              shippingAddress = {
                id: orderRow.addr_id,
                label: orderRow.addr_label,
                line1: orderRow.addr_line1,
                line2: orderRow.addr_line2,
                city: orderRow.addr_city,
                state: orderRow.addr_state,
                pincode: orderRow.addr_pincode,
                country: orderRow.addr_country,
                phone: orderRow.addr_phone,
              };
            } else {
              // 2️⃣ Fallback to shipping_json_raw or shipping_address_raw
              const rawCandidates = [orderRow.shipping_json, orderRow.shipping_address];
              for (const raw of rawCandidates) {
                if (!raw && raw !== "") continue;
                try {
                  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                  if (parsed && typeof parsed === "object") {
                    shippingAddress = {
                      id: parsed.id ?? null,
                      label: parsed.label ?? parsed.title ?? parsed.name ?? null,
                      line1: parsed.line1 ?? parsed.address_line1 ?? parsed.address1 ?? parsed.address ?? null,
                      line2: parsed.line2 ?? parsed.address_line2 ?? parsed.address2 ?? null,
                      city: parsed.city ?? parsed.town ?? null,
                      state: parsed.state ?? null,
                      pincode: parsed.pincode ?? parsed.postcode ?? parsed.zip ?? null,
                      country: parsed.country ?? null,
                      phone: parsed.phone ?? parsed.mobile ?? null,
                    };
                    break;
                  }
                } catch {
                  const trimmed = raw.toString().trim();
                  if (trimmed) {
                    shippingAddress = {
                      id: null,
                      label: null,
                      line1: trimmed,
                      line2: null,
                      city: null,
                      state: null,
                      pincode: null,
                      country: null,
                      phone: null,
                    };
                    break;
                  }
                }
              }
            }

            return {
              id: orderRow.id,
              user_id: orderRow.user_id,
              user_name: orderRow.user_name ?? null,
              status: orderRow.status,
              total_amount: orderRow.total_amount,
              created_at: orderRow.created_at,
              shipping_address: shippingAddress,
              items: itemsByOrder[orderRow.id] || [],
            };
          });

          res.json({
            data: result,
            meta: {
              total,
              page,
              pages: Math.max(1, Math.ceil(total / limit)),
              limit,
            },
          });
        };

        // Fetch items if any orderIds exist
        if (!orderIds || orderIds.length === 0) {
          fetchItemsAndRespond();
          return;
        }

        const placeholders = orderIds.map(() => "?").join(",");
        const itemSql = `
          SELECT 
            oi.order_id,
            oi.quantity,
            oi.price,
            p.id AS product_id,
            p.name,
            p.images,
            oi.selectedColor,
            oi.selectedSize
          FROM order_items oi
          JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id IN (${placeholders})
        `;

        db.all(itemSql, orderIds, (itemsErr, itemsRows) => {
          if (itemsErr) {
            console.error("Error fetching order items:", itemsErr);
            return res.status(500).json({ message: "Failed to fetch order items" });
          }
          (itemsRows || []).forEach(item => {
            if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
            itemsByOrder[item.order_id].push({
              id: item.product_id,
              name: item.name,
              image: item.images,
              quantity: item.quantity,
              price: item.price,
              options: {
                color: item.selectedColor,
                size: item.selectedSize,
              },
            });
          });
          fetchItemsAndRespond();
        });
      });
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ message: "Server error" });
  }
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










