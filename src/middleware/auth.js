import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
import turso from "../db.js";
import { z } from "zod";
import crypto from "crypto";

/**
 * @typedef {{ public_id: string; username: string; role_id?: number; token_version?: number }} TokenPayload
 */

const tokenSchema = z.object({
  public_id: z.string(),
  username: z.string(),
  role_id: z.number().int().optional(),
  token_version: z.number().int().optional(),
});

export const auth = async (req, res, next) => {
  const apiKeyHeader = req.headers["x-api-key"] || req.headers["X-API-KEY"];
  if (apiKeyHeader) {
    try {
      const provided = String(apiKeyHeader).trim();
      const keyHash = crypto
        .createHash("sha256")
        .update(provided)
        .digest("hex");
      const result = await turso.execute({
        sql: "SELECT id, public_id, owner_user_id, name, permissions, disabled FROM api_keys WHERE key_hash = ? LIMIT 1",
        args: [keyHash],
      });
      const row = result.rows[0];
      if (!row || row.disabled) {
        return res.status(403).json({ error: "Invalid API key" });
      }
      req.user = {
        id: row.owner_user_id,
        // Do not embed internal numeric api_key id into any value that may be exposed to clients.
        username: `api_key:${row.public_id ?? row.id}`,
        is_api_key: true,
        api_key_id: row.id,
        api_key_name: row.name,
        permissions: row.permissions ? JSON.parse(row.permissions) : [],
      };
      return next();
    } catch (err) {
      return res
        .status(403)
        .json({ error: "Invalid API key", details: err.message });
    }
  }

  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Missing token" });

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const parsed = tokenSchema.safeParse(decoded);
    if (!parsed.success) {
      return res.status(403).json({
        error: "Invalid token payload",
        details: z.treeifyError(parsed.error),
      });
    }

    // Resolve internal user id from public_id stored in token
    const publicId = parsed.data.public_id;
    const result = await turso.execute({
      sql: "SELECT id, token_version, role_id, username FROM users WHERE public_id = ? LIMIT 1",
      args: [publicId],
    });

    if (!result.rows[0]) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check token version
    if (
      (result.rows[0].token_version ?? null) !==
      (parsed.data.token_version ?? null)
    ) {
      return res.status(403).json({ error: "Token invalidated" });
    }

    // Build req.user with internal id for server-side logic
    req.user = {
      id: result.rows[0].id,
      public_id: publicId,
      username: result.rows[0].username,
      role_id: result.rows[0].role_id,
      token_version: result.rows[0].token_version,
    };

    next();
  } catch (error) {
    // z.treeifyError expects a ZodError-like object with an `issues` array.
    // Avoid calling it on JWT or other errors which don't have `issues`.
    let details;
    if (error && Array.isArray(error.issues)) {
      try {
        details = z.treeifyError(error);
      } catch (e) {
        details = String(error.message ?? error);
      }
    } else {
      details = String(error?.message ?? error);
    }

    res.status(403).json({
      error: "Invalid or expired token",
      details,
    });
  }
};
