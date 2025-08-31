const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./dripzoid.db");

const createUser = (name, email, password, callback) => {
  const query = `INSERT INTO users (name, email, password) VALUES (?, ?, ?)`;
  db.run(query, [name, email, password], function (err) {
    if (err) return callback(err);
    callback(null, this.lastID);
  });
};

const findUserByEmail = (email, callback) => {
  const query = `SELECT * FROM users WHERE email = ?`;
  db.get(query, [email], (err, row) => {
    if (err) return callback(err);
    callback(null, row);
  });
};

module.exports = { createUser, findUserByEmail };
