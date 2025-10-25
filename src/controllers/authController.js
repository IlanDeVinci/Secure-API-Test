import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import turso from "../db.js";
import dotenv from "dotenv";
import generatePublicIds from "../utils/generatePublicIds.js";

dotenv.config();
const SECRET = process.env.JWT_SECRET;

// Controllers for user registration and login.

// Register user
export const register = async (req, res) => {
  const { username, password, role, email } = req.body;
  if (!username || !password || !email)
    return res.status(400).json({ error: "Missing fields" });

  const hash = await bcrypt.hash(password, 10);
  try {
    const roleResult = await turso.execute({
      sql: "SELECT id FROM roles WHERE name = ?",
      args: [role || "user"],
    });
    const roleId = roleResult.rows[0]?.id;

    if (!roleId) return res.status(400).json({ error: "Invalid role" });

    const publicId = generatePublicIds("user");
    await turso.execute({
      sql: `INSERT INTO users (public_id, username, password, role_id, email) VALUES (?, ?, ?, ?, ?)`,
      args: [publicId, username, hash, roleId, email],
    });
    res.json({ message: "User registered successfully", public_id: publicId });
  } catch (err) {
    res.status(400).json({
      error: "Username already exists or DB error",
      details: err.message,
    });
  }
};

// Login user
export const login = async (req, res) => {
  const { username, password } = req.body;

  const result = await turso.execute({
    sql: "SELECT u.*, r.can_post_login FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = ?",
    args: [username],
  });

  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });

  if (!user.can_post_login) {
    return res.status(403).json({ error: "Login permission denied" });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Invalid password" });

  // Sign token with public_id (not internal numeric id) so clients cannot see internal ids
  const token = jwt.sign(
    {
      public_id: user.public_id,
      username: user.username,
      role_id: user.role_id,
      token_version: user.token_version,
    },
    SECRET,
    { expiresIn: "1h" }
  );
  res.json({ token });
};
