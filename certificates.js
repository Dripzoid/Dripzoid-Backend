// routes/certificates.js
import express from "express";
import multer from "multer";
import cloudinary from "./cloudinary.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// DB
let db;
(async () => {
  db = await open({
    filename: process.env.DATABASE_FILE || "./dripzoid.db",
    driver: sqlite3.Database,
  });

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
})();

// POST /api/certificates
router.post(
  "/",
  upload.fields([{ name: "certificate" }, { name: "qr" }]),
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
        return res.status(400).json({ message: "Missing required fields" });
      }

      const certFile = req.files?.certificate?.[0];
      const qrFile = req.files?.qr?.[0];

      // Upload PDF as RAW file
      let certificate_url = null;
      if (certFile) {
        const uploadPdf = await cloudinary.uploader.upload_stream(
          {
            resource_type: "raw",
            folder: "certificates",
            public_id: certificate_id,
            format: "pdf",
          },
          (error, result) => {
            if (error) throw error;
            certificate_url = result.secure_url;
          }
        );
        uploadPdf.end(certFile.buffer);
      }

      // Upload QR as image
      let qr_url = null;
      if (qrFile) {
        const uploadQr = await cloudinary.uploader.upload_stream(
          {
            folder: "certificates/qr",
            public_id: certificate_id + "-qr",
          },
          (error, result) => {
            if (error) throw error;
            qr_url = result.secure_url;
          }
        );
        uploadQr.end(qrFile.buffer);
      }

      await db.run(
        `INSERT INTO certificates
        (id, application_id, intern_name, role, start_date, end_date, issue_date, certificate_url, qr_url)
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

      res.json({
        success: true,
        certificate_id,
        certificate_url,
        qr_url,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to upload certificate" });
    }
  }
);

export default router;
