// backend/seed.js
import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new sqlite3.Database(path.join(__dirname, "dripzoid.db"), (err) => {
  if (err) console.error("❌ DB connection error:", err.message);
  else console.log("✅ Connected to SQLite database");
});

async function seed() {
  try {
    console.log("🗑 Clearing old data...");
    await runAsync(`DELETE FROM order_items`);
    await runAsync(`DELETE FROM orders`);
    await runAsync(`DELETE FROM products`);
    await runAsync(`DELETE FROM users`);

    console.log("👤 Inserting dummy users...");
    const passwordHash = await bcrypt.hash("password123", 10);
    const adminId = await insertUser("Admin User", "admin@example.com", "9999999999", passwordHash, 1);
    const userId = await insertUser("John Doe", "john@example.com", "8888888888", passwordHash, 0);

    console.log("📦 Inserting dummy products...");
    const productIds = [];
    productIds.push(await insertProduct("Nike Air Max", "Men", 7999, "https://via.placeholder.com/300", 4.5, "7,8,9", "Black", 9999, "Comfortable running shoes", "Shoes", 20));
    productIds.push(await insertProduct("Adidas Hoodie", "Men", 3499, "https://via.placeholder.com/300", 4.7, "M,L,XL", "Grey", 3999, "Warm winter hoodie", "Clothing", 15));
    productIds.push(await insertProduct("Puma T-Shirt", "Women", 1999, "https://via.placeholder.com/300", 4.3, "S,M,L", "White", 2499, "Cotton t-shirt", "Clothing", 30));

    console.log("🛒 Inserting dummy orders...");
    const orderId = await insertOrder(userId, 11498, "COD", "pending");

    console.log("📦 Linking order items...");
    await insertOrderItem(orderId, productIds[0], 1, 7999);
    await insertOrderItem(orderId, productIds[1], 1, 3499);

    console.log("✅ Dummy data inserted successfully!");
  } catch (err) {
    console.error("❌ Seeding error:", err);
  } finally {
    db.close();
  }
}

// Helpers
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

function insertUser(name, email, phone, password, is_admin) {
  return runAsync(
    `INSERT INTO users (name, email, phone, password, is_admin) VALUES (?, ?, ?, ?, ?)`,
    [name, email, phone, password, is_admin]
  );
}

function insertProduct(name, category, price, images, rating, sizes, color, originalPrice, description, subcategory, stock) {
  return runAsync(
    `INSERT INTO products (name, category, price, images, rating, sizes, color, originalPrice, description, subcategory, stock, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [name, category, price, images, rating, sizes, color, originalPrice, description, subcategory, stock]
  );
}

function insertOrder(user_id, total_amount, payment_method, status) {
  return runAsync(
    `INSERT INTO orders (user_id, total_amount, payment_method, status, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [user_id, total_amount, payment_method, status]
  );
}

function insertOrderItem(order_id, product_id, quantity, unit_price) {
  return runAsync(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)`,
    [order_id, product_id, quantity, unit_price]
  );
}

// Run
seed();
