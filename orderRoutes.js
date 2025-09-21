// routes/orderRoutes.js
import express from "express";
import db from "./db.js"; // SQLite connection
import { auth } from "./auth.js"; // ✅ auth middleware

const router = express.Router();

// Helper functions for Promises
const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this); // this.lastID, this.changes
    });
  });

const getQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

const allQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

/**
 * POST /place-order
 *
 * Supports two flows:
 *  - buyNow: true  -> req.body.items: [ { product_id, quantity, product_snapshot? } ]
 *  - buyNow: false -> req.body.cartItems: [ { id (cart_row_id or sometimes product id), quantity? } ] OR [ { product_id } ]
 *
 * Ensures:
 *  - Validates ownership of cart rows for cart flow
 *  - Validates product existence and available stock
 *  - Starts transaction, inserts order + order_items, updates stock, deletes processed cart rows (only)
 */
router.post("/place-order", auth, async (req, res) => {
  const {
    cartItems = [],
    items = [],
    buyNow = false,
    shippingAddress,
    paymentMethod,
    paymentDetails,
    totalAmount,
  } = req.body;

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const cartItemsArr = Array.isArray(cartItems) ? cartItems : [];
  const itemsArr = Array.isArray(items) ? items : [];

  // --- Helper: normalize shipping address ---
  const normalizeAddress = (addr) => {
    if (!addr) return {};
    return {
      id: addr.id ?? null,
      label: addr.label ?? addr.name ?? null,
      line1: addr.line1 ?? addr.address_line1 ?? addr.address1 ?? null,
      line2: addr.line2 ?? addr.address_line2 ?? addr.address2 ?? null,
      city: addr.city ?? null,
      state: addr.state ?? null,
      pincode: addr.pincode ?? addr.zip ?? addr.postcode ?? null,
      country: addr.country ?? "India",
      phone: addr.phone ?? null,
    };
  };

  const shippingAddrNormalized = normalizeAddress(shippingAddress);

  try {
    await runQuery("BEGIN TRANSACTION");

    // ---------- BUY NOW FLOW ----------
    if (buyNow) {
      if (!itemsArr.length) {
        await runQuery("ROLLBACK");
        return res.status(400).json({ error: "No items provided for buy-now" });
      }

      // Validate stock for each item
      for (const it of itemsArr) {
        const productId = it.product_id ?? it.product?.id ?? it.product_snapshot?.id ?? null;
        const qty = Number(it.quantity ?? 1);
        if (!productId) throw new Error("Missing product_id in buy-now item");
        if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Invalid quantity for product ${productId}`);

        const product = await getQuery(`SELECT * FROM products WHERE id = ?`, [productId]);
        if (!product) throw new Error(`Product not found: ${productId}`);
        if (product.stock !== null && Number(product.stock) < qty) throw new Error(`Insufficient stock for product ${productId}`);
      }

      const orderInsert = await runQuery(
        `INSERT INTO orders 
          (user_id, address_id, shipping_address, payment_method, payment_details, total_amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Confirmed', datetime('now', 'localtime'))`,
        [
          userId,
          shippingAddrNormalized.id, // store address_id if available
          JSON.stringify(shippingAddrNormalized), // normalized JSON
          paymentMethod || "",
          JSON.stringify(paymentDetails || {}),
          totalAmount ?? 0,
        ]
      );
      const orderId = orderInsert.lastID;

      // Insert order items & update stock
      for (const it of itemsArr) {
        const productId = it.product_id ?? it.product?.id ?? it.product_snapshot?.id;
        const qty = Number(it.quantity ?? 1);
        const product = await getQuery(`SELECT price FROM products WHERE id = ?`, [productId]);
        const price = Number(product?.price ?? it.price ?? 0);

        await runQuery(
          `INSERT INTO order_items (order_id, product_id, quantity, price, selectedColor, selectedSize) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [orderId, productId, qty, price, it.selectedColor ?? null, it.selectedSize ?? null]
        );

        const upd = await runQuery(
          `UPDATE products
           SET stock = stock - ?, sold = COALESCE(sold,0) + ?
           WHERE id = ? AND (stock IS NULL OR stock >= ?)`,
          [qty, qty, productId, qty]
        );

        if (!upd || upd.changes === 0) {
          throw new Error(`Insufficient stock when committing product ${productId}`);
        }
      }

      await runQuery("COMMIT");
      return res.status(200).json({ success: true, orderId });
    }

    // ---------- CART FLOW ----------
    if (!cartItemsArr.length) {
      await runQuery("ROLLBACK");
      return res.status(400).json({ error: "No cart items provided" });
    }

    const cartRowIdsToDelete = [];
    const validatedItems = [];

    for (const item of cartItemsArr) {
      const productId = item.product_id ?? item.id;
      const cartEntry = await getQuery(
        `SELECT * FROM cart_items WHERE (id = ? OR product_id = ?) AND user_id = ?`,
        [item.id, productId, userId]
      );
      if (!cartEntry) throw new Error(`Cart item not found or not owned by user: ${productId}`);

      const qty = Number(item.quantity ?? cartEntry.quantity ?? 1);
      const product = await getQuery(`SELECT * FROM products WHERE id = ?`, [productId]);
      if (!product) throw new Error(`Product not found: ${productId}`);
      if (product.stock !== null && Number(product.stock) < qty) throw new Error(`Insufficient stock for product ${productId}`);

      validatedItems.push({
        product_id: productId,
        quantity: qty,
        cart_id: cartEntry.id,
        selectedColor: item.selectedColor ?? null,
        selectedSize: item.selectedSize ?? null,
      });
      cartRowIdsToDelete.push(cartEntry.id);
    }

    const orderInsert = await runQuery(
      `INSERT INTO orders 
        (user_id, address_id, shipping_address, payment_method, payment_details, total_amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now','localtime'))`,
      [
        userId,
        shippingAddrNormalized.id,
        JSON.stringify(shippingAddrNormalized),
        paymentMethod || "",
        JSON.stringify(paymentDetails || {}),
        totalAmount ?? 0,
      ]
    );
    const orderId = orderInsert.lastID;

    for (const v of validatedItems) {
      const product = await getQuery(`SELECT price FROM products WHERE id = ?`, [v.product_id]);
      const price = Number(product?.price ?? 0);

      await runQuery(
        `INSERT INTO order_items (order_id, product_id, quantity, price, selectedColor, selectedSize) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, v.product_id, v.quantity, price, v.selectedColor, v.selectedSize]
      );

      const upd = await runQuery(
        `UPDATE products
         SET stock = stock - ?, sold = COALESCE(sold,0) + ?
         WHERE id = ? AND (stock IS NULL OR stock >= ?)`,
        [v.quantity, v.quantity, v.product_id, v.quantity]
      );

      if (!upd || upd.changes === 0) {
        throw new Error(`Insufficient stock when committing product ${v.product_id}`);
      }
    }

    if (cartRowIdsToDelete.length > 0) {
      const placeholders = cartRowIdsToDelete.map(() => "?").join(",");
      await runQuery(
        `DELETE FROM cart_items WHERE id IN (${placeholders}) AND user_id = ?`,
        [...cartRowIdsToDelete, userId]
      );
    }

    await runQuery("COMMIT");
    return res.status(200).json({ success: true, orderId });
  } catch (err) {
    console.error("Order insert error:", err?.message || err);
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr?.message || rollbackErr);
    }
    return res.status(500).json({ error: "Could not place order", details: err?.message || String(err) });
  }
});



/**
 * GET /orders/:id
 */
router.get("/orders/:id", auth, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const order = await getQuery(
      `SELECT * FROM orders WHERE id = ? AND user_id = ?`,
      [orderId, userId]
    );
    if (!order) return res.status(404).json({ error: "Order not found" });

    const items = await allQuery(
      `SELECT oi.*, p.name AS product_name, p.images AS product_images
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    res.json({ success: true, order, items });
  } catch (err) {
    console.error("Fetch order error:", err.message);
    res.status(500).json({ error: "Could not fetch order" });
  }
});

/**
 * GET /
 */
router.get("/", auth, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const orders = await allQuery(
      `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    if (!orders.length) return res.json({ success: true, orders: [] });

    const orderIds = orders.map((o) => o.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const items = await allQuery(
      `SELECT oi.*, p.name AS product_name, p.images AS product_images
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id IN (${placeholders})`,
      orderIds
    );

    const ordersWithItems = orders.map((order) => ({
      ...order,
      items: items.filter((it) => it.order_id === order.id),
    }));

    res.json({ success: true, orders: ordersWithItems });
  } catch (err) {
    console.error("Fetch orders error:", err.message);
    res.status(500).json({ error: "Could not fetch orders" });
  }
});

// backend/routes/orderRoutes.js - status endpoint
router.get("/status", auth, (req, res) => {
  const ids = req.query.ids?.split(",").map(id => parseInt(id, 10)).filter(Boolean);

  if (!ids || !ids.length) {
    return res.status(400).json({ message: "No order IDs provided" });
  }

  const placeholders = ids.map(() => "?").join(",");
  const sql = `SELECT id, status FROM orders WHERE id IN (${placeholders}) AND user_id = ?`;

  db.all(sql, [...ids, req.user.id], (err, rows) => {
    if (err) {
      console.error("Error fetching order statuses:", err);
      return res.status(500).json({ message: "Failed to fetch statuses" });
    }
    res.json(rows);
  });
});

// backend/routes/orderRoutes.js - simple SSE stream
router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: "ping", time: new Date() })}\n\n`);
  }, 10000);

  req.on("close", () => {
    clearInterval(interval);
  });
});

export default router;






