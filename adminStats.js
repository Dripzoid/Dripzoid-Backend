// backend/routes/adminStats.js
import express from "express";
import db from "./db.js";
import authMiddleware from "./authAdmin.js";

const router = express.Router();

/**
 * Helpers to parse date/week/month into an inclusive start (>=) and exclusive end (<)
 * All returned values are date strings in 'YYYY-MM-DD HH:MM:SS' (UTC-like) suitable for string comparison in SQLite
 */

// format Date object to 'YYYY-MM-DD'
const fmtDate = (d) => {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const rangeFromDate = (dateStr) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  try {
    const start = new Date(Date.UTC(
      Number(dateStr.slice(0, 4)),
      Number(dateStr.slice(5, 7)) - 1,
      Number(dateStr.slice(8, 10)),
      0, 0, 0
    ));
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    return [`${fmtDate(start)} 00:00:00`, `${fmtDate(end)} 00:00:00`];
  } catch (e) {
    return null;
  }
};

const rangeFromMonth = (monthStr) => {
  if (!/^\d{4}-\d{2}$/.test(monthStr)) return null;
  try {
    const yyyy = Number(monthStr.slice(0, 4));
    const mm = Number(monthStr.slice(5, 7));
    const start = new Date(Date.UTC(yyyy, mm - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(yyyy, mm, 1, 0, 0, 0));
    return [`${fmtDate(start)} 00:00:00`, `${fmtDate(end)} 00:00:00`];
  } catch (e) {
    return null;
  }
};

const isoWeekStart = (year, week) => {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const mondayOfWeek1 = new Date(jan4.getTime() - (dayOfWeek - 1) * 24 * 3600 * 1000);
  const start = new Date(mondayOfWeek1.getTime() + (week - 1) * 7 * 24 * 3600 * 1000);
  return start;
};

const rangeFromWeek = (weekStr) => {
  const m = /^(\d{4})-W?(\d{1,2})$/i.exec(weekStr);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const ww = Number(m[2]);
  if (!Number.isFinite(yyyy) || !Number.isFinite(ww) || ww < 1 || ww > 53) return null;
  try {
    const start = isoWeekStart(yyyy, ww);
    const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
    return [`${fmtDate(start)} 00:00:00`, `${fmtDate(end)} 00:00:00`];
  } catch (e) {
    return null;
  }
};

/**
 * GET /api/admin/stats
 */
router.get("/stats", authMiddleware, (req, res) => {
  try {
    const { date: dateParam, week: weekParam, month: monthParam } = req.query;

    let range = null;
    if (dateParam) {
      range = rangeFromDate(String(dateParam));
    } else if (weekParam) {
      range = rangeFromWeek(String(weekParam));
    } else if (monthParam) {
      range = rangeFromMonth(String(monthParam));
    }

    let whereClause = "";
    let whereParams = [];
    if (Array.isArray(range) && range.length === 2) {
      whereClause = " WHERE created_at >= ? AND created_at < ? ";
      whereParams = [range[0], range[1]];
    }

    const ordersSql = `
      SELECT
        COUNT(*) AS totalOrders,
        SUM(CASE WHEN LOWER(status) = 'delivered' THEN 1 ELSE 0 END) AS deliveredOrders,
        SUM(CASE WHEN LOWER(status) = 'cancelled' THEN 1 ELSE 0 END) AS cancelledOrders,
        SUM(CASE WHEN LOWER(status) = 'pending' THEN 1 ELSE 0 END) AS pendingOrders,
        SUM(CASE WHEN LOWER(status) = 'confirmed' THEN 1 ELSE 0 END) AS confirmedOrders,
        SUM(CASE WHEN LOWER(status) = 'shipped' THEN 1 ELSE 0 END) AS shippedOrders,
        IFNULL(SUM(total_amount), 0) AS totalSales
      FROM orders
      ${whereClause};
    `;

    const itemsSql = range ? `
      SELECT IFNULL(SUM(oi.quantity), 0) AS totalItemsSold
      FROM order_items oi
      INNER JOIN orders o ON oi.order_id = o.id
      ${whereClause.replace(/created_at/g, "o.created_at")};
    ` : `
      SELECT IFNULL(SUM(quantity), 0) AS totalItemsSold
      FROM order_items;
    `;

    const productsSql = `
      SELECT
        COUNT(*) AS totalProducts,
        IFNULL(SUM(CASE WHEN sold IS NOT NULL THEN sold ELSE 0 END), 0) AS soldProducts,
        IFNULL(SUM(CASE WHEN stock > 0 THEN 1 ELSE 0 END), 0) AS inStock,
        IFNULL(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END), 0) AS outOfStock
      FROM products;
    `;

    // ✅ Extended to compute gender stats
    const usersSql = `
      SELECT 
        COUNT(*) AS totalUsers,
        SUM(CASE WHEN LOWER(gender) = 'male' THEN 1 ELSE 0 END) AS maleUsers,
        SUM(CASE WHEN LOWER(gender) = 'female' THEN 1 ELSE 0 END) AS femaleUsers,
        SUM(CASE WHEN gender IS NULL OR LOWER(gender) NOT IN ('male','female') THEN 1 ELSE 0 END) AS otherUsers
      FROM users;
    `;

    db.get(ordersSql, whereParams, (err, orderStats) => {
      if (err) return res.status(500).json({ message: "Database error (orders)", error: err.message });

      db.get(itemsSql, whereParams, (err, itemStats) => {
        if (err) return res.status(500).json({ message: "Database error (items)", error: err.message });

        db.get(productsSql, [], (err, productStats) => {
          if (err) return res.status(500).json({ message: "Database error (products)", error: err.message });

          db.get(usersSql, [], (err, userStats) => {
            if (err) return res.status(500).json({ message: "Database error (users)", error: err.message });

            res.json({
              // Orders
              totalOrders: orderStats?.totalOrders ?? 0,
              deliveredOrders: orderStats?.deliveredOrders ?? 0,
              cancelledOrders: orderStats?.cancelledOrders ?? 0,
              pendingOrders: orderStats?.pendingOrders ?? 0,
              confirmedOrders: orderStats?.confirmedOrders ?? 0,
              shippedOrders: orderStats?.shippedOrders ?? 0,
              totalSales: orderStats?.totalSales ?? 0,
              totalItemsSold: itemStats?.totalItemsSold ?? 0,

              // Products
              total: productStats?.totalProducts ?? 0,
              sold: productStats?.soldProducts ?? 0,
              inStock: productStats?.inStock ?? 0,
              outOfStock: productStats?.outOfStock ?? 0,

              // Users
              totalUsers: userStats?.totalUsers ?? 0,
              maleUsers: userStats?.maleUsers ?? 0,
              femaleUsers: userStats?.femaleUsers ?? 0,
              otherUsers: userStats?.otherUsers ?? 0,
            });
          });
        });
      });
    });
  } catch (outerErr) {
    console.error("Unexpected error in /api/admin/stats:", outerErr);
    res.status(500).json({ message: "Unexpected server error", error: String(outerErr) });
  }
});

export default router;
