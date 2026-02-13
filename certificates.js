// routes/certificates.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { fileURLToPath } from "url";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// DB path — adapt to your project
const DB_PATH = process.env.DATABASE_FILE || path.join(__dirname, "../dripzoid.db");

// Ensure upload directories
const CERT_UPLOAD_DIR = path.join(process.cwd(), "uploads", "certificates");
fs.mkdirSync(CERT_UPLOAD_DIR, { recursive: true });

// multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CERT_UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`),
});
const upload = multer({ storage });

// Open DB (simple)
let db;
(async () => {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Create certificates table if not exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY,
      application_id TEXT,
      intern_name TEXT,
      role TEXT,
      start_date TEXT,
      end_date TEXT,
      issue_date TEXT,
      certificate_url TEXT,
      qr_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
})();

// POST /api/certificates
router.post("/", upload.fields([{ name: "certificate" }, { name: "qr" }]), async (req, res) => {
  try {
    const {
      application_id,
      certificate_id,
      intern_name,
      role,
      start_date,
      end_date,
      issue_date,
    } = req.body;

    if (!application_id || !certificate_id || !intern_name) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const certFile = req.files?.certificate?.[0];
    const qrFile = req.files?.qr?.[0];

    const certificate_url = certFile ? `/uploads/certificates/${path.basename(certFile.path)}` : null;
    const qr_url = qrFile ? `/uploads/certificates/${path.basename(qrFile.path)}` : null;

    await db.run(
      `INSERT INTO certificates (id, application_id, intern_name, role, start_date, end_date, issue_date, certificate_url, qr_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        certificate_id,
        application_id,
        intern_name,
        role,
        start_date,
        end_date,
        issue_date,
        certificate_url,
        qr_url,
      ]
    );

    return res.json({ message: "Certificate saved", certificate_id, certificate_url, qr_url });
  } catch (err) {
    console.error("certificates POST error:", err);
    return res.status(500).json({ message: "Failed to save certificate" });
  }
});

export default router;
