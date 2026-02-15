import express from "express";
import multer from "multer";
import cloudinary from "./cloudinary.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import authMiddleware from "./authAdmin.js"; // <-- ADD THIS
import PDFDocument from "pdfkit";
import fs from "fs";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Helper: upload buffer to Cloudinary
function uploadBufferToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    stream.end(buffer);
  });
}

/* =========================================================
   DB init + ensure schema
   ========================================================= */
let db;
(async () => {
  db = await open({
    filename: process.env.DATABASE_FILE || path.join(process.cwd(), "dripzoid.db"),
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
    }
  }
})();

/* =========================================================
   🔒 POST /api/certificates (ADMIN ONLY)
   ========================================================= */
router.post(
  "/",
  authMiddleware, // <-- PROTECTED
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

      const existing = await db.get(
        "SELECT * FROM certificates WHERE application_id = ?",
        [application_id]
      );

      if (existing) {
        return res.json({
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

      const certUpload = await uploadBufferToCloudinary(certFile.buffer, {
        resource_type: "image",
        folder: "certificates",
        public_id: certificate_id,
        overwrite: true,
      });

      const certificate_url = certUpload.secure_url;

      let qr_url = null;
      if (qrFile) {
        const qrUpload = await uploadBufferToCloudinary(qrFile.buffer, {
          resource_type: "image",
          folder: "certificates/qr",
          public_id: `${certificate_id}-qr`,
          overwrite: true,
        });
        qr_url = qrUpload.secure_url;
      }

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

      await db.run(
        `UPDATE applications SET certificate_generated = 1 WHERE id = ?`,
        [application_id]
      );

      res.json({
        success: true,
        certificate_id,
        certificate_url,
        qr_url,
      });
    } catch (err) {
      console.error("Certificate Upload Error:", err);
      res.status(500).json({ message: "Failed to upload certificate" });
    }
  }
);

/* =========================================================
   🔒 GET certificate by application (ADMIN ONLY)
   ========================================================= */
router.get(
  "/application/:applicationId",
  authMiddleware, // <-- PROTECTED
  async (req, res) => {
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
  }
);

/* =========================================================
   🌐 PUBLIC JSON Verification (NO AUTH)
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
    

    const LOGO_URL = "https://res.cloudinary.com/dvid0uzwo/image/upload/v1771150544/my_project/lk1uulpgg3gdgi2fyfbp.png";
        // helper to format DD-MM-YYYY
    const formatDate = (dateStr) => {
      if (!dateStr) return "-";
      const d = new Date(dateStr);
      if (isNaN(d)) return dateStr;
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = d.getFullYear();
      return `${dd}-${mm}-${yyyy}`;
    };


    if (!row) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Certificate Verification</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
          <style>
            *{box-sizing:border-box;margin:0;padding:0}
            body{
              font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,Arial;
              min-height:100vh;
              display:flex;
              align-items:center;
              justify-content:center;
              background: radial-gradient(circle at top, #1e293b, #020617);
              color:white;
              padding:20px;
            }
            .wrapper{
              width:100%;
              max-width:600px;
              text-align:center;
            }
            .brand{
              display:flex;
              align-items:center;
              justify-content:center;
              gap:12px;
              margin-bottom:24px;
            }
            .brand img{
              height:52px;
              object-fit:contain;
            }
            .brand span{
              font-weight:700;
              font-size:20px;
              letter-spacing:.5px;
            }
            .card{
              border-radius:20px;
              padding:40px 30px;
              background:rgba(255,255,255,0.08);
              backdrop-filter:blur(18px);
              box-shadow:0 20px 60px rgba(0,0,0,0.35);
            }
            h2{
              font-size:26px;
              margin-bottom:10px;
            }
            p{
              font-size:15px;
              color:#e2e8f0;
            }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="brand">
              <img src="${LOGO_URL}" alt="Dripzoid Logo"/>
              <span>Dripzoid Certificate Verification</span>
            </div>
            <div class="card">
              <h2>❌ Certificate Not Found</h2>
              <p>This certificate is invalid, revoked, or does not exist in our records.</p>
            </div>
          </div>
        </body>
        </html>
      `);
    }

    const startDate = formatDate(row.start_date);
    const endDate = formatDate(row.end_date);
    const issueDate = formatDate(row.issue_date);
   res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>Certificate Verification</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{
            font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,Arial;
            min-height:100vh;
            display:flex;
            align-items:center;
            justify-content:center;
            background: radial-gradient(circle at top, #1e293b, #020617);
            color:#0f172a;
            padding:20px;
          }
          .wrapper{width:100%;max-width:700px;}
          .brand{
            display:flex;align-items:center;justify-content:center;
            gap:12px;margin-bottom:24px;color:white;
          }
          .brand img{height:52px;object-fit:contain;}
          .brand span{font-weight:700;font-size:20px;letter-spacing:0.5px;}
          .card{
            border-radius:20px;padding:36px 30px;
            background:rgba(255,255,255,0.92);
            backdrop-filter: blur(18px);
            box-shadow:0 20px 60px rgba(0,0,0,0.35);
            text-align:center;
          }
          .status{
            display:inline-flex;align-items:center;gap:10px;
            font-weight:700;color:#16a34a;background:#ecfdf5;
            padding:10px 18px;border-radius:999px;margin-bottom:18px;font-size:14px;
          }
          .status::before{content:"✔";font-weight:900;}
          h2{font-size:28px;margin-bottom:12px;color:#020617;}
          .meta{
            margin-top:20px;
            display:grid;
            grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
            gap:16px;text-align:left;
          }
          .meta div{
            background:#f8fafc;padding:14px 16px;
            border-radius:12px;border:1px solid #e2e8f0;
          }
          .label{font-size:12px;font-weight:600;color:#64748b;margin-bottom:4px;}
          .value{font-size:15px;font-weight:600;color:#0f172a;}
          .btn{
            margin-top:28px;display:inline-block;padding:14px 26px;
            border-radius:12px;text-decoration:none;font-weight:700;
            background:#020617;color:white;transition:.25s ease;
            box-shadow:0 10px 25px rgba(0,0,0,0.25);
          }
          .btn:hover{transform:translateY(-2px);box-shadow:0 14px 35px rgba(0,0,0,0.35);}
          .footer{margin-top:22px;font-size:12px;color:#64748b;}
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="brand">
            <img src="${LOGO_URL}" alt="Dripzoid Logo"/>
            <span>Dripzoid Certificate Verification</span>
          </div>

          <div class="card">
            <div class="status">Certificate Verified</div>

            <h2>${row.intern_name}</h2>

            <div class="meta">
              <div>
                <div class="label">Role</div>
                <div class="value">${row.role || "-"}</div>
              </div>
              <div>
                <div class="label">Duration</div>
                <div class="value">${startDate} → ${endDate}</div>
              </div>
              <div>
                <div class="label">Issue Date</div>
                <div class="value">${issueDate}</div>
              </div>
            </div>

            <a class="btn" href="${row.certificate_url}" target="_blank">
              View Certificate
            </a>

            <div class="footer">
              Verified digitally by Dripzoid • Authentic Internship Certificate
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Verification failed");
  }
});

/* =========================================================
   🔒 DOWNLOAD CERTIFICATE AS PDF (DIRECT STREAM, NO UPLOAD)
   GET /api/certificates/:certificateId/download-pdf
   ========================================================= */
router.get(
  "/:certificateId/download-pdf",
  async (req, res) => {
    try {
      const { certificateId } = req.params;

      // fetch certificate record
      const row = await db.get(
        "SELECT * FROM certificates WHERE id = ?",
        [certificateId]
      );

      if (!row || !row.certificate_url) {
        return res.status(404).json({ message: "Certificate image not found" });
      }

      const imageUrl = row.certificate_url;

      // fetch image buffer from cloudinary
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

      // create PDF
      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margin: 0,
      });

      // set headers for download
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${certificateId}.pdf"`
      );

      // pipe PDF directly to response
      doc.pipe(res);

      // add image full page
      doc.image(imageBuffer, 0, 0, {
        width: doc.page.width,
        height: doc.page.height,
      });

      doc.end();
    } catch (err) {
      console.error("PDF Stream Error:", err);
      res.status(500).json({ message: "Failed to generate PDF" });
    }
  }
);




export default router;
