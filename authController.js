const bcrypt = require("bcrypt");
const { createUser, findUserByEmail } = require("./userModel");

const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    findUserByEmail(email, async (err, existingUser) => {
      if (err) return res.status(500).json({ message: "DB error" });
      if (existingUser) {
        return res.status(400).json({ message: "User already exists" });
      }

      try {
        const hashedPassword = await bcrypt.hash(password, 10);
        createUser(name, email, hashedPassword, (err, userId) => {
          if (err) return res.status(500).json({ message: "DB error" });
          res.status(201).json({ message: "User registered", userId });
        });
      } catch (hashErr) {
        return res.status(500).json({ message: "Error hashing password" });
      }
    });
  } catch (e) {
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { register };

