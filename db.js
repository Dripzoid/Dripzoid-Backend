import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use DATABASE_FILE from .env or fallback to local file
const dbPath = process.env.DATABASE_FILE || path.join(__dirname, "dripzoid.db");

// ✅ Check if the DB file exists before connecting (optional on first run)
if (!fs.existsSync(dbPath)) {
  console.warn(`⚠️ Database file not found at: ${dbPath} — a new one will be created.`);
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("❌ SQLite connection error:", err.message);
  } else {
    console.log(`✅ Connected to SQLite database at: ${dbPath}`);
  }
});

// Optional: log all tables to confirm correct DB
db.all("SELECT name FROM sqlite_master WHERE type='table';", (err, rows) => {
  if (err) {
    console.error("❌ Error reading tables:", err.message);
  } else {
    console.log("📂 Tables in database:", rows.map(r => r.name));
  }
});

export default db;
