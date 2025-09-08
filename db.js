import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to your database file
const dbPath = path.join(__dirname, "dripzoid.db");

// ✅ Check if the DB file exists before connecting
if (!fs.existsSync(dbPath)) {
  throw new Error(`❌ Database file not found at: ${dbPath}`);
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
