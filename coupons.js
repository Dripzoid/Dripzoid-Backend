/**
 * coupons.js
 * Coupon routes – SQLite powered
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(bodyParser.json({ limit: '2mb' }));

/* ----------------- Paths & DB ----------------- */
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.sqlite');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ----------------- Helpers ----------------- */
const uid = (p = 'c_') => `${p}${Math.random().toString(36).slice(2, 9)}`;
const nowISO = () => new Date().toISOString();

/* ----------------- Schema ----------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  type TEXT CHECK(type IN ('percentage','fixed')) NOT NULL,
  amount REAL NOT NULL,
  min_purchase REAL DEFAULT 0,
  usage_limit INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER DEFAULT 1,
  applies_to TEXT DEFAULT 'all',
  description TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS coupon_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id TEXT,
  order_id TEXT,
  user_id TEXT,
  discount_amount REAL,
  used_at TEXT,
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS coupon_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id TEXT,
  action TEXT,
  message TEXT,
  actor TEXT DEFAULT 'system',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS coupon_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id TEXT,
  target_type TEXT,
  target_id TEXT,
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE
);
`);

/* ----------------- Audit Helper ----------------- */
const audit = (coupon_id, action, message, actor = 'system') => {
  db.prepare(`
    INSERT INTO coupon_audit_logs (coupon_id, action, message, actor, created_at)
    VALUES (?,?,?,?,?)
  `).run(coupon_id, action, message, actor, nowISO());
};

/* ----------------- Health ----------------- */
router.get('/health', (_, res) => res.json({ ok: true }));

/* ----------------- List Coupons ----------------- */
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM coupons
    ORDER BY created_at DESC
  `).all();
  res.json(rows);
});

/* ----------------- Create Coupon ----------------- */
router.post('/', (req, res) => {
  const c = req.body;
  if (!c.code) return res.status(400).json({ error: 'code_required' });

  const id = uid();
  db.prepare(`
    INSERT INTO coupons
    (id, code, type, amount, min_purchase, usage_limit, used, starts_at, ends_at, active, applies_to, description, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    c.code.toUpperCase(),
    c.type || 'percentage',
    c.amount || 0,
    c.min_purchase || 0,
    c.usage_limit || 0,
    0,
    c.starts_at || null,
    c.ends_at || null,
    c.active ? 1 : 0,
    c.applies_to || 'all',
    c.description || '',
    nowISO(),
    nowISO()
  );

  audit(id, 'CREATED', `Created coupon ${c.code}`);
  res.status(201).json({ id });
});

/* ----------------- Update Coupon ----------------- */
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const c = req.body;

  db.prepare(`
    UPDATE coupons SET
      code = ?,
      type = ?,
      amount = ?,
      min_purchase = ?,
      usage_limit = ?,
      active = ?,
      description = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    c.code,
    c.type,
    c.amount,
    c.min_purchase,
    c.usage_limit,
    c.active ? 1 : 0,
    c.description,
    nowISO(),
    id
  );

  audit(id, 'UPDATED', `Updated coupon ${c.code}`);
  res.json({ ok: true });
});

/* ----------------- Delete Coupon ----------------- */
router.delete('/:id', (req, res) => {
  db.prepare(`DELETE FROM coupons WHERE id = ?`).run(req.params.id);
  audit(req.params.id, 'DELETED', 'Coupon deleted');
  res.json({ ok: true });
});

/* ----------------- BULK ACTIONS ----------------- */
router.post('/bulk', (req, res) => {
  const { action, ids } = req.body;

  const tx = db.transaction(() => {
    ids.forEach(id => {
      if (action === 'enable')
        db.prepare(`UPDATE coupons SET active = 1 WHERE id = ?`).run(id);
      if (action === 'disable')
        db.prepare(`UPDATE coupons SET active = 0 WHERE id = ?`).run(id);
      if (action === 'delete')
        db.prepare(`DELETE FROM coupons WHERE id = ?`).run(id);
    });
  });

  tx();
  audit(null, `BULK_${action.toUpperCase()}`, `${ids.length} coupons affected`);
  res.json({ ok: true });
});

/* ----------------- 🔥 ATOMIC REDEEM API ----------------- */
router.post('/redeem', (req, res) => {
  const { code, order_id, user_id, cart_total } = req.body;

  if (!code) return res.status(400).json({ error: 'code_required' });

  try {
    const tx = db.transaction(() => {
      const coupon = db.prepare(`
        SELECT * FROM coupons
        WHERE code = ? AND active = 1
      `).get(code.toUpperCase());

      if (!coupon) throw new Error('invalid_coupon');
      if (coupon.usage_limit && coupon.used >= coupon.usage_limit)
        throw new Error('usage_limit_reached');
      if (coupon.min_purchase && cart_total < coupon.min_purchase)
        throw new Error('min_purchase_not_met');

      const discount =
        coupon.type === 'percentage'
          ? (cart_total * coupon.amount) / 100
          : coupon.amount;

      db.prepare(`
        UPDATE coupons SET used = used + 1 WHERE id = ?
      `).run(coupon.id);

      db.prepare(`
        INSERT INTO coupon_usage
        (coupon_id, order_id, user_id, discount_amount, used_at)
        VALUES (?,?,?,?,?)
      `).run(
        coupon.id,
        order_id || null,
        user_id || null,
        discount,
        nowISO()
      );

      audit(coupon.id, 'REDEEMED', `Coupon ${coupon.code} redeemed`);

      return { discount, coupon };
    });

    const result = tx();
    res.json({ success: true, ...result });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ----------------- Analytics ----------------- */
router.get('/analytics', (_, res) => {
  const total = db.prepare(`SELECT SUM(used) as t FROM coupons`).get().t || 0;
  res.json({ totalRedemptions: total });
});

/* ----------------- Audit Logs ----------------- */
router.get('/audit', (_, res) => {
  const rows = db.prepare(`
    SELECT * FROM coupon_audit_logs
    ORDER BY created_at DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

/* ----------------- Export ----------------- */
module.exports = router;
