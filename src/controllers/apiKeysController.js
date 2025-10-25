import turso from "../db.js";
import crypto from "crypto";
import { z } from "zod";
import generatePublicIds from "../utils/generatePublicIds.js";

// Controller for creating, listing and deleting API keys.
// POST /api-keys accepts a single object or an array of objects to create multiple keys.
// DELETE expects { public_ids: ["pub_abc","pub_def"] } and removes only keys owned by the requester.

const singleSchema = z.object({
  name: z.string().min(1),
  permissions: z.array(z.string()).optional(),
});

const createPayloadSchema = z.union([singleSchema, z.array(singleSchema)]);

export const createApiKeys = async (req, res) => {
  const parsed = createPayloadSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: z.treeifyError(parsed.error) });

  const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const created = [];

  try {
    for (const item of items) {
      const raw = crypto.randomBytes(32).toString("hex");
      const keyHash = crypto.createHash("sha256").update(raw).digest("hex");
      const publicId = generatePublicIds("api_key");
      const permsJson = JSON.stringify(item.permissions || []);
      await turso.execute({
        sql: "INSERT INTO api_keys (public_id, key_hash, name, owner_user_id, permissions) VALUES (?, ?, ?, ?, ?)",
        args: [publicId, keyHash, item.name, req.user.id, permsJson],
      });
      const sel = await turso.execute({
        sql: "SELECT public_id, name, permissions, created_at FROM api_keys WHERE key_hash = ? LIMIT 1",
        args: [keyHash],
      });
      const row = sel.rows[0];
      created.push({
        public_id: row.public_id,
        name: row.name,
        permissions: row.permissions ? JSON.parse(row.permissions) : [],
        created_at: row.created_at,
        raw_key: raw,
        message: "Store this raw key securely; it will not be shown again.",
      });
    }

    res.status(201).json({ created });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to create api keys", details: err.message });
  }
};

export const listApiKeys = async (req, res) => {
  try {
    const result = await turso.execute({
      sql: "SELECT public_id, name, permissions, created_at, disabled FROM api_keys WHERE owner_user_id = ?",
      args: [req.user.id],
    });
    const rows = result.rows.map((r) => ({
      public_id: r.public_id,
      name: r.name,
      permissions: r.permissions ? JSON.parse(r.permissions) : [],
      created_at: r.created_at,
      disabled: !!r.disabled,
    }));
    res.json(rows);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to fetch api keys", details: err.message });
  }
};

const deleteSchema = z.object({
  public_ids: z.array(z.string().min(1)),
});

export const deleteApiKeys = async (req, res) => {
  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: z.treeifyError(parsed.error) });

  const publicIds = parsed.data.public_ids;
  if (!Array.isArray(publicIds) || publicIds.length === 0) {
    return res
      .status(400)
      .json({ error: "public_ids must be a non-empty array" });
  }

  try {
    // delete only keys owned by the requester
    const placeholders = publicIds.map(() => "?").join(",");
    const args = [...publicIds, req.user.id];
    const sql = `DELETE FROM api_keys WHERE public_id IN (${placeholders}) AND owner_user_id = ?`;
    await turso.execute({ sql, args });
    res.json({ message: "Deleted requested api keys (owned by you)" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to delete api keys", details: err.message });
  }
};
