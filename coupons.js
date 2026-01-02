/**
 * coupon-server-sqlite.js
 * Node + Express + SQLite implementation of coupon server
 *
 * Usage:
 *   npm init -y
 *   npm install express multer cors body-parser better-sqlite3
 *   API_BASE=https://api.dripzoid.com node coupon-server-sqlite.js
 *
 * Notes:
 *  - Uses better-sqlite3 (synchronous, lightweight) for simplicity and stability.
 *  - Database file is created at ./data/db.sqlite
 *  - Make sure process has write permissions to ./data
 *  - For production: add authentication, rate limiting, input validation, backups.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.sqlite');

const API_BASE = process.env.API_BASE || 'https://api.dripzoid.com';
const PORT = process.env.PORT || 4000;

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(bodyParser.json({ limit: '2mb' }));

// CORS: allow API_BASE and localhost dev ports
const allowedOrigins = [
  API_BASE,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4000',
  'http://127.0.0.1:3000',
];
app.use(cors({
  origin: function(origin, callback) {
    // allow requests with no origin (mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error('CORS policy: origin not allowed'), false);
  },
}));

/* ----------------- Helpers ----------------- */
function uid(prefix = 'c_') {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}
function nowISO() {
  return new Date().toISOString();
}
function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('\n') || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
// robust CSV parser supporting quoted fields
function parseCSV(text) {
  const rows = [];
  let cur = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nxt = text[i + 1];
    if (ch === '"') {
      if (inQuotes && nxt === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      row.push(cur);
      cur = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (cur !== '' || row.length > 0) {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      }
      if (ch === '\r' && nxt === '\n') i++;
      continue;
    }
    cur += ch;
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/* ----------------- Ensure data dir and DB init ----------------- */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // better concurrency
db.pragma('foreign_keys = ON');  // enforce FK constraints

function initDb() {
  // coupons table
  db.exec(`
    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('percentage','fixed')),
      amount REAL NOT NULL CHECK(amount >= 0),
      min_purchase REAL DEFAULT 0 CHECK(min_purchase >= 0),
      usage_limit INTEGER DEFAULT 0 CHECK(usage_limit >= 0),
      used INTEGER DEFAULT 0 CHECK(used >= 0),
      starts_at TEXT,
      ends_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      applies_to TEXT NOT NULL DEFAULT 'all' CHECK(applies_to IN ('all','shipping','category','product')),
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // coupon_usage table
  db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_id TEXT NOT NULL,
      order_id TEXT,
      user_id TEXT,
      discount_amount REAL NOT NULL,
      used_at TEXT NOT NULL,
      FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE
    );
  `);

  // coupon_audit_logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_id TEXT,
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      actor TEXT DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL
    );
  `);

  // coupon_targets table
  db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('category','product')),
      target_id TEXT NOT NULL,
      FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE
    );
  `);

  // helpful indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_coupons_active ON coupons(active);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_coupons_type ON coupons(type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_coupons_dates ON coupons(starts_at, ends_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_coupon ON coupon_usage(coupon_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_coupon ON coupon_audit_logs(coupon_id);`);
}

initDb();

/* ----------------- DB helpers (prepared statements) ----------------- */

// coupons
const stmtInsertCoupon = db.prepare(`
  INSERT INTO coupons (id, code, type, amount, min_purchase, usage_limit, used, starts_at, ends_at, active, applies_to, description, created_at, updated_at)
  VALUES (@id, @code, @type, @amount, @min_purchase, @usage_limit, @used, @starts_at, @ends_at, @active, @applies_to, @description, @created_at, @updated_at)
`);

const stmtGetCouponById = db.prepare(`SELECT * FROM coupons WHERE id = ?`);
const stmtGetCouponByCode = db.prepare(`SELECT * FROM coupons WHERE LOWER(code) = LOWER(?)`);
const stmtUpdateCoupon = db.prepare(`
  UPDATE coupons SET
    code = @code,
    type = @type,
    amount = @amount,
    min_purchase = @min_purchase,
    usage_limit = @usage_limit,
    used = @used,
    starts_at = @starts_at,
    ends_at = @ends_at,
    active = @active,
    applies_to = @applies_to,
    description = @description,
    updated_at = @updated_at
  WHERE id = @id
`);
const stmtDeleteCoupon = db.prepare(`DELETE FROM coupons WHERE id = ?`);

// audit
const stmtInsertAudit = db.prepare(`
  INSERT INTO coupon_audit_logs (coupon_id, action, message, actor, created_at)
  VALUES (@coupon_id, @action, @message, @actor, @created_at)
`);

// counts and listing will be done ad-hoc with queries below

/* helper for audit */
function pushAudit(couponId, action, message, actor = 'system') {
  try {
    stmtInsertAudit.run({
      coupon_id: couponId,
      action,
      message,
      actor,
      created_at: nowISO(),
    });
  } catch (e) {
    console.error('pushAudit error', e);
  }
}

/* ----------------- Seed sample coupon if empty ----------------- */
const couponCount = db.prepare(`SELECT COUNT(1) as c FROM coupons`).get().c;
if (!couponCount) {
  const id = uid();
  stmtInsertCoupon.run({
    id,
    code: 'WELCOME-10',
    type: 'percentage',
    amount: 10,
    min_purchase: 0,
    usage_limit: 1000,
    used: 12,
    starts_at: new Date().toISOString().slice(0, 10),
    ends_at: null,
    active: 1,
    applies_to: 'all',
    description: 'New user discount',
    created_at: nowISO(),
    updated_at: nowISO(),
  });
  pushAudit(id, 'CREATED', `Seed coupon created: WELCOME-10`);
}

/* ----------------- Endpoints ----------------- */

// health
app.get('/api/health', (req, res) => res.json({ ok: true, ts: nowISO(), api_base: API_BASE }));

// list coupons (with filters, pagination, sort)
app.get('/api/coupons', (req, res) => {
  const {
    search = '',
    type = 'all',
    active = 'all',
    page = '1',
    perPage = '25',
    sortBy = 'created_at',
    sortDir = 'desc',
  } = req.query;

  // build where clause safely
  let whereParts = [];
  const params = {};

  if (active === 'active') whereParts.push('active = 1');
  if (active === 'inactive') whereParts.push('active = 0');
  if (type !== 'all') {
    whereParts.push('type = @type');
    params.type = type;
  }
  if (search && String(search).trim()) {
    whereParts.push('(LOWER(code) LIKE @q OR LOWER(description) LIKE @q)');
    params.q = `%${String(search).toLowerCase()}%`;
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const validSortCols = ['created_at', 'updated_at', 'code', 'amount', 'used', 'type'];
  const sortCol = validSortCols.includes(sortBy) ? sortBy : 'created_at';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const p = Math.max(1, Number(page) || 1);
  const pp = Math.max(1, Number(perPage) || 25);
  const offset = (p - 1) * pp;

  const totalStmt = db.prepare(`SELECT COUNT(1) as total FROM coupons ${where}`);
  const total = totalStmt.get(params).total;

  const stmt = db.prepare(`
    SELECT * FROM coupons
    ${where}
    ORDER BY ${sortCol} ${dir}
    LIMIT @limit OFFSET @offset
  `);
  const rows = stmt.all({ ...params, limit: pp, offset });

  res.json({ data: rows, page: p, perPage: pp, total });
});

// get single coupon
app.get('/api/coupons/:id', (req, res) => {
  const { id } = req.params;
  const row = stmtGetCouponById.get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

// create coupon
app.post('/api/coupons', (req, res) => {
  const body = req.body || {};
  if (!body.code) return res.status(400).json({ error: 'code_required' });

  const existing = stmtGetCouponByCode.get(body.code);
  if (existing) return res.status(409).json({ error: 'code_exists' });

  const newId = uid();
  const rec = {
    id: newId,
    code: String(body.code).toUpperCase(),
    type: body.type || 'percentage',
    amount: Number(body.amount || 0),
    min_purchase: Number(body.min_purchase || 0),
    usage_limit: Number(body.usage_limit || 0),
    used: Number(body.used || 0),
    starts_at: body.starts_at || null,
    ends_at: body.ends_at || null,
    active: body.active === undefined ? 1 : (body.active ? 1 : 0),
    applies_to: body.applies_to || 'all',
    description: (body.metadata && body.metadata.description) || body.description || '',
    created_at: nowISO(),
    updated_at: nowISO(),
  };

  try {
    stmtInsertCoupon.run(rec);
    pushAudit(newId, 'CREATED', `Created coupon ${rec.code}`, body.actor || 'system');
    res.status(201).json(rec);
  } catch (e) {
    console.error('create coupon error', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// update coupon
app.put('/api/coupons/:id', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const existing = stmtGetCouponById.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const updated = {
    id,
    code: (body.code || existing.code).toUpperCase(),
    type: body.type || existing.type,
    amount: Number(body.amount ?? existing.amount),
    min_purchase: Number(body.min_purchase ?? existing.min_purchase),
    usage_limit: Number(body.usage_limit ?? existing.usage_limit),
    used: Number(body.used ?? existing.used),
    starts_at: body.starts_at ?? existing.starts_at,
    ends_at: body.ends_at ?? existing.ends_at,
    active: body.active === undefined ? existing.active : (body.active ? 1 : 0),
    applies_to: body.applies_to || existing.applies_to,
    description: (body.metadata && body.metadata.description) || body.description || existing.description,
    updated_at: nowISO(),
  };

  try {
    stmtUpdateCoupon.run(updated);
    pushAudit(id, 'UPDATED', `Edited coupon ${updated.code}`, body.actor || 'system');
    res.json({ ...existing, ...updated });
  } catch (e) {
    console.error('update coupon error', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// delete coupon
app.delete('/api/coupons/:id', (req, res) => {
  const { id } = req.params;
  const existing = stmtGetCouponById.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  try {
    stmtDeleteCoupon.run(id);
    pushAudit(id, 'DELETED', `Deleted coupon ${existing.code}`, 'system');
    res.json({ ok: true });
  } catch (e) {
    console.error('delete coupon err', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// bulk actions
app.post('/api/coupons/bulk', (req, res) => {
  const { action, ids } = req.body || {};
  if (!Array.isArray(ids) || !action) return res.status(400).json({ error: 'invalid' });

  try {
    const trx = db.transaction(() => {
      if (action === 'enable') {
        const st = db.prepare(`UPDATE coupons SET active = 1, updated_at = @now WHERE id = @id`);
        for (const id of ids) st.run({ id, now: nowISO() });
        pushAudit(null, 'BULK_ENABLED', `Bulk enabled ${ids.length} coupons`, 'system');
      } else if (action === 'disable') {
        const st = db.prepare(`UPDATE coupons SET active = 0, updated_at = @now WHERE id = @id`);
        for (const id of ids) st.run({ id, now: nowISO() });
        pushAudit(null, 'BULK_DISABLED', `Bulk disabled ${ids.length} coupons`, 'system');
      } else if (action === 'delete') {
        const st = db.prepare(`DELETE FROM coupons WHERE id = @id`);
        for (const id of ids) st.run({ id });
        pushAudit(null, 'BULK_DELETED', `Bulk deleted ${ids.length} coupons`, 'system');
      } else {
        throw new Error('unknown_action');
      }
    });
    trx();
    res.json({ ok: true });
  } catch (e) {
    console.error('bulk action error', e);
    res.status(400).json({ error: e.message || 'unknown' });
  }
});

// import CSV (multipart)
app.post('/api/coupons/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const text = req.file.buffer.toString('utf8');
  const rows = parseCSV(text);
  if (!rows || rows.length < 2) return res.status(400).json({ error: 'no_rows' });

  const headers = rows[0].map(h => String(h).trim());
  const parsed = rows.slice(1).map(r => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = r[i] || '';
    return obj;
  });

  try {
    const insert = db.prepare(`
      INSERT INTO coupons
        (id, code, type, amount, min_purchase, usage_limit, used, starts_at, ends_at, active, applies_to, description, created_at, updated_at)
      VALUES
        (@id, @code, @type, @amount, @min_purchase, @usage_limit, @used, @starts_at, @ends_at, @active, @applies_to, @description, @created_at, @updated_at)
    `);

    const txn = db.transaction((items) => {
      for (const p of items) {
        const rec = {
          id: p.id || uid(),
          code: (p.code || `C-${Math.random().toString(36).slice(2,6)}`).toUpperCase(),
          type: p.type || 'percentage',
          amount: Number(p.amount) || 0,
          min_purchase: Number(p.min_purchase) || 0,
          usage_limit: Number(p.usage_limit) || 0,
          used: Number(p.used) || 0,
          starts_at: p.starts_at || null,
          ends_at: p.ends_at || null,
          active: (p.active === 'true' || p.active === true) ? 1 : 0,
          applies_to: p.applies_to || 'all',
          description: p.metadata_description || p.description || '',
          created_at: p.created_at || nowISO(),
          updated_at: p.updated_at || nowISO(),
        };
        insert.run(rec);
      }
    });

    txn(parsed);
    pushAudit(null, 'CSV_IMPORT', `Imported ${parsed.length} coupons from CSV`, 'system');
    res.json({ imported: parsed.length });
  } catch (e) {
    console.error('csv import err', e);
    res.status(500).json({ error: 'import_failed', detail: e.message });
  }
});

// export CSV
app.get('/api/coupons/export', (req, res) => {
  const rows = db.prepare(`
    SELECT id, code, type, amount, min_purchase, usage_limit, used, starts_at, ends_at, active, applies_to, description AS metadata_description, created_at, updated_at
    FROM coupons
    ORDER BY created_at DESC
  `).all();

  const headers = [
    'id',
    'code',
    'type',
    'amount',
    'min_purchase',
    'usage_limit',
    'used',
    'starts_at',
    'ends_at',
    'active',
    'applies_to',
    'metadata_description',
    'created_at',
    'updated_at',
  ];
  const out = [headers.join(',')];
  for (const r of rows) {
    out.push(headers.map(h => csvEscape(r[h])).join(','));
  }
  const csv = out.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="coupons_export_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// analytics
app.get('/api/analytics', (req, res) => {
  const totalRedemptionsRow = db.prepare(`SELECT SUM(used) as total FROM coupons`).get();
  const totalRedemptions = totalRedemptionsRow.total || 0;

  const byTypeRows = db.prepare(`SELECT type, SUM(used) as total FROM coupons GROUP BY type`).all();
  const byType = {};
  for (const r of byTypeRows) byType[r.type] = r.total || 0;

  const couponCount = db.prepare(`SELECT COUNT(1) as c FROM coupons`).get().c || 0;

  res.json({ totalRedemptions, byType, couponCount });
});

// audit
app.get('/api/audit', (req, res) => {
  const rows = db.prepare(`SELECT * FROM coupon_audit_logs ORDER BY created_at DESC LIMIT 500`).all();
  res.json(rows);
});

/* ----------------- Start server ----------------- */
app.listen(PORT, () => {
  console.log(`Coupon server (SQLite) listening on http://localhost:${PORT}`);
  console.log(`API_BASE is set to ${API_BASE}`);
});
