// routes/jobs.js
import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const router = express.Router();

/* =========================================================
   Fix __dirname for ES Modules
   ========================================================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   Database Path (env or fallback)
   ========================================================= */
const dbPath =
  process.env.DATABASE_FILE || path.join(__dirname, "./dripzoid.db");

/* =========================================================
   File Upload Config (Resume Uploads)
   ========================================================= */
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

/* =========================================================
   Open SQLite DB + Create Tables
   ========================================================= */
let db;
(async () => {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  // Enable foreign keys
  await db.exec(`PRAGMA foreign_keys = ON;`);

  // Jobs table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      location TEXT,
      department TEXT,
      duration TEXT,
      stipend TEXT,
      status TEXT DEFAULT 'Open',
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Applications table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      portfolio TEXT,
      cover TEXT,
      resume_url TEXT,
      status TEXT DEFAULT 'Applied',
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
  `);

  console.log("SQLite connected & tables ready ✅");
})();

/* =========================================================
   GET /api/jobs  → list all jobs
   ========================================================= */
router.get("/", async (req, res) => {
  try {
    const jobs = await db.all(
      "SELECT * FROM jobs ORDER BY created_at DESC"
    );
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch jobs" });
  }
});

/* =========================================================
   GET /api/jobs/:slug  → single job details
   ========================================================= */
router.get("/:slug", async (req, res) => {
  try {
    const job = await db.get("SELECT * FROM jobs WHERE slug = ?", [
      req.params.slug,
    ]);

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch job" });
  }
});

/* =========================================================
   POST /api/jobs  → create new job (admin)
   ========================================================= */
router.post("/", async (req, res) => {
  try {
    const {
      id,
      slug,
      title,
      type,
      location,
      department,
      duration,
      stipend,
      status,
      description,
    } = req.body;

    if (!id || !slug || !title || !type) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    await db.run(
      `INSERT INTO jobs
      (id, slug, title, type, location, department, duration, stipend, status, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        slug,
        title,
        type,
        location,
        department,
        duration,
        stipend,
        status || "Open",
        description,
      ]
    );

    res.json({ success: true, message: "Job created successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create job" });
  }
});

/* =========================================================
   POST /api/jobs/apply  → submit application
   ========================================================= */
router.post("/apply", upload.single("resume"), async (req, res) => {
  try {
    const { jobId, name, email, phone, portfolio, cover } = req.body;

    if (!jobId || !name || !email) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const id = "app_" + Date.now();

    await db.run(
      `INSERT INTO applications
      (id, job_id, name, email, phone, portfolio, cover, resume_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        jobId,
        name,
        email,
        phone,
        portfolio,
        cover,
        req.file ? `/uploads/${path.basename(req.file.path)}` : null,
      ]
    );

    res.json({
      success: true,
      message: "Application submitted successfully",
      applicationId: id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to submit application" });
  }
});

/* =========================================================
   GET /api/jobs/applications/all  → list all applications (admin)
   ========================================================= */
router.get("/applications/all", async (req, res) => {
  try {
    const apps = await db.all(
      "SELECT * FROM applications ORDER BY applied_at DESC"
    );
    res.json(apps);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch applications" });
  }
});

export default router;
