
import dotenv from "dotenv";

dotenv.config();
const sqlite3 = require("sqlite3").verbose();
const dbPath = process.env.DATABASE_FILE || path.resolve("./dripzoid.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("❌ Failed to connect to database:", err.message);
  } else {
    console.log("✅ Connected to SQLite at:", dbPath);
  }
});
db.all("SELECT * FROM users", [], (err, rows) => {
  if (err) {
    throw err;
  }
  console.log(rows);
  db.close();
});

