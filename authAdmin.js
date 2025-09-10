import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config(); // load .env variables

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn("Warning: JWT_SECRET not set in .env!");
}

/**
 * Auth middleware to protect admin routes
 */
export default async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (!authHeader) {
      return res.status(401).json({ message: "No token provided" });
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Invalid authorization format" });
    }

    const token = parts[1];
    if (!token) return res.status(401).json({ message: "Token missing" });

    // promisify jwt.verify
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });

    if (!decoded || !decoded.is_admin) {
      return res.status(403).json({ message: "Access denied: Admins only" });
    }

    // attach user payload to request
    req.user = decoded;
    next();
  } catch (err) {
    console.error("authMiddleware error:", err);
    if (err.name === "TokenExpiredError") {
      return res.status(403).json({ message: "Token expired" });
    }
    return res.status(403).json({ message: "Invalid token" });
  }
}
