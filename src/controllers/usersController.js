import turso from "../db.js";
import bcrypt from "bcrypt";

export const getMyUser = async (req, res) => {
  const result = await turso.execute({
    sql: `SELECT u.public_id, u.username, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?`,
    args: [req.user.id],
  });
  res.json(result.rows[0]);
};

export const getUsers = async (req, res) => {
  const result = await turso.execute({
    sql: `SELECT u.public_id, u.username, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id`,
  });
  res.json(result.rows);
};

export const changePassword = async (req, res) => {
  const newPassword = req.body.password;
  if (!newPassword) return res.status(400).json({ error: "Missing password" });

  const hash = await bcrypt.hash(newPassword, 10);

  await turso.execute({
    sql: "UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?",
    args: [hash, req.user.id],
  });

  res.json({ message: "Password updated. Please re-login." });
};

export const changeRole = async (req, res) => {
  const { userPublicId, newRole } = req.body;

  if (!userPublicId || !newRole) {
    return res.status(400).json({ error: "Missing userPublicId or newRole" });
  }

  try {
    const roleResult = await turso.execute({
      sql: "SELECT id FROM roles WHERE name = ?",
      args: [newRole],
    });
    const roleId = roleResult.rows[0]?.id;

    if (!roleId) return res.status(400).json({ error: "Invalid role" });

    // Resolve internal user id from public_id
    const userSel = await turso.execute({
      sql: "SELECT id FROM users WHERE public_id = ? LIMIT 1",
      args: [userPublicId],
    });
    const targetUserId = userSel.rows[0]?.id;
    if (!targetUserId) return res.status(404).json({ error: "User not found" });

    await turso.execute({
      sql: "UPDATE users SET role_id = ?, token_version = token_version + 1 WHERE id = ?",
      args: [roleId, targetUserId],
    });

    res.json({
      message: "User role updated successfully. User must re-login.",
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to update user role", details: err.message });
  }
};
