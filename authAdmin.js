import jwt from "jsonwebtoken";

const JWT_SECRET = "Dripzoid.App@2025"; // keep in sync with server.js

export default function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ message: "No token provided" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token missing" });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: "Invalid or expired token" });

    if (!decoded.is_admin) {
      return res.status(403).json({ message: "Access denied: Admins only" });
    }

    req.user = decoded;
    next();
  });
}
