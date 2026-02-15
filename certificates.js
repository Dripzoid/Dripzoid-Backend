// routes/certificates.js
import express from "express";
import multer from "multer";
import cloudinary from "./cloudinary.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Helper: upload buffer to Cloudinary via upload_stream wrapped in Promise
function uploadBufferToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    stream.end(buffer);
  });
}

// DB init + ensure schema
let db;
(async () => {
  db = await open({
    filename: process.env.DATABASE_FILE || path.join(process.cwd(), "dripzoid.db"),
    driver: sqlite3.Database,
  });

  // Create certificates table
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
    )
  `);

  // Ensure applications table has certificate_generated column
  const appsTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='applications'"
  );

  if (appsTable) {
    const cols = await db.all(`PRAGMA table_info(applications)`);
    const hasFlag = cols.some((c) => c.name === "certificate_generated");
    if (!hasFlag) {
      await db.exec(
        `ALTER TABLE applications ADD COLUMN certificate_generated INTEGER DEFAULT 0`
      );
      console.log("Added certificate_generated column to applications table");
    }
  }
})();

/* =========================================================
   POST /api/certificates → Upload Certificate Image + QR
   ========================================================= */
router.post(
  "/",
  upload.fields([{ name: "certificate", maxCount: 1 }, { name: "qr", maxCount: 1 }]),
  async (req, res) => {
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
        return res.status(400).json({
          message: "Missing required fields (application_id | certificate_id | intern_name)",
        });
      }

      // Prevent duplicate certificate for same application
      const existing = await db.get(
        "SELECT * FROM certificates WHERE application_id = ?",
        [application_id]
      );

      if (existing) {
        return res.status(200).json({
          message: "Certificate already exists",
          certificate_id: existing.id,
          certificate_url: existing.certificate_url,
          qr_url: existing.qr_url,
        });
      }

      const certFile = req.files?.certificate?.[0];
      const qrFile = req.files?.qr?.[0];

      if (!certFile) {
        return res.status(400).json({ message: "Certificate image required" });
      }

      /* =====================================================
         Upload certificate image to Cloudinary (resource_type: image)
         ===================================================== */
      const certUpload = await uploadBufferToCloudinary(certFile.buffer, {
        resource_type: "image",
        folder: "certificates",
        public_id: certificate_id,
        overwrite: true,
        access_mode: "public",
        type: "upload",
      });

      const certificate_url = certUpload.secure_url || certUpload.url || null;

      // Provide a download-forced URL (Cloudinary fl_attachment) for convenience
      let certificate_download_url = null;
      if (certificate_url) {
        // replace the first occurrence of /upload/ with /upload/fl_attachment/
        certificate_download_url = certificate_url.replace("/upload/", "/upload/fl_attachment/");
      }

      /* =====================================================
         Upload QR image
         ===================================================== */
      let qr_url = null;
      if (qrFile) {
        const qrUpload = await uploadBufferToCloudinary(qrFile.buffer, {
          resource_type: "image",
          folder: "certificates/qr",
          public_id: `${certificate_id}-qr`,
          overwrite: true,
        });
        qr_url = qrUpload.secure_url || qrUpload.url || null;
      }

      /* =====================================================
         Save in DB
         ===================================================== */
      await db.run(
        `INSERT INTO certificates
          (id, application_id, intern_name, role, start_date, end_date, issue_date, certificate_url, qr_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          certificate_id,
          application_id,
          intern_name,
          role || null,
          start_date || null,
          end_date || null,
          issue_date || null,
          certificate_url,
          qr_url,
        ]
      );

      // Mark application as certificate generated
      await db.run(
        `UPDATE applications SET certificate_generated = 1 WHERE id = ?`,
        [application_id]
      );

      res.json({
        success: true,
        certificate_id,
        certificate_url,
        certificate_download_url,
        qr_url,
      });
    } catch (err) {
      console.error("Certificate Upload Error:", err);
      res.status(500).json({ message: "Failed to upload certificate" });
    }
  }
);

/* =========================================================
   GET /api/certificates/application/:applicationId
   ========================================================= */
router.get("/application/:applicationId", async (req, res) => {
  try {
    const row = await db.get(
      "SELECT * FROM certificates WHERE application_id = ?",
      [req.params.applicationId]
    );
    if (!row) return res.status(404).json({ message: "Certificate not found" });

    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch certificate" });
  }
});

/* =========================================================
   PUBLIC JSON Verification
   GET /api/certificates/public/:certificateId
   ========================================================= */
router.get("/public/:certificateId", async (req, res) => {
  try {
    const row = await db.get(
      "SELECT * FROM certificates WHERE id = ?",
      [req.params.certificateId]
    );

    if (!row) {
      return res.status(404).json({
        valid: false,
        message: "Certificate not found",
      });
    }

    res.json({
      valid: true,
      certificate_id: row.id,
      intern_name: row.intern_name,
      role: row.role,
      start_date: row.start_date,
      end_date: row.end_date,
      issue_date: row.issue_date,
      certificate_url: row.certificate_url,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Verification failed" });
  }
});

/* =========================================================
   PUBLIC HTML Verification Page (QR redirect page)
   GET /api/certificates/public/view/:certificateId
   ========================================================= */
router.get("/public/view/:certificateId", async (req, res) => {
  try {
    const row = await db.get(
      "SELECT * FROM certificates WHERE id = ?",
      [req.params.certificateId]
    );

    if (!row) {
      return res.send(`
        <h2>❌ Certificate Not Found</h2>
        <p>This certificate is invalid or does not exist.</p>
      `);
    }

    res.send(`
      <html>
      <head>
        <title>Certificate Verification</title>
        <style>
          body { font-family: Arial; padding: 40px; text-align:center; }
          .card { max-width:600px;margin:auto;padding:30px;border:1px solid #eee;border-radius:12px; }
          .valid { color:green;font-size:24px;font-weight:bold; }
          a { text-decoration:none;color:#2563eb;font-weight:bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="valid">✔ Certificate Verified</div>
          <h2>${row.intern_name}</h2>
          <p><strong>Role:</strong> ${row.role}</p>
          <p><strong>Duration:</strong> ${row.start_date} → ${row.end_date}</p>
          <p><strong>Issued:</strong> ${row.issue_date}</p>
          <br/>
          <a href="${row.certificate_url}" target="_blank">View Certificate</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Verification failed");
  }
});

export default router;
