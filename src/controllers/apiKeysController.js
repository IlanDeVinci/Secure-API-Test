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
    // Determine the creator's effective permissions so we can ensure
    // they cannot grant permissions they don't have.
    let creatorPerms = [];
    let creatorIsAdmin = false; // whether the creator is an admin (has all perms by role)
    let roleRow = {}; // populated for user-account creators so we can introspect can_* columns
    if (req.user?.is_api_key) {
      creatorPerms = Array.isArray(req.user.permissions)
        ? req.user.permissions
        : [];

      // API keys are never considered admins here
      creatorIsAdmin = false;
    } else {
      // Resolve role permissions for the authenticated user
      const roleRes = await turso.execute({
        sql: "SELECT r.* FROM roles r JOIN users u ON u.role_id = r.id WHERE u.id = ? LIMIT 1",
        args: [req.user.id],
      });
      roleRow = roleRes.rows[0] || {};
      // Build permission names from columns like `can_<permission>`
      creatorPerms = Object.keys(roleRow)
        .filter((k) => k.startsWith("can_"))
        .filter((k) => {
          const v = roleRow[k];
          return (
            v === 1 ||
            v === "1" ||
            v === true ||
            String(v).toUpperCase() === "TRUE"
          );
        })
        .map((k) => k.slice(4));
      // Consider the user an admin if the role name is 'admin'.
      // (There is no special creator 'all' permission to rely on.)
      creatorIsAdmin = (roleRow.role_name || "").toLowerCase() === "admin";
    }

    for (const item of items) {
      // Validate that the requested permissions are a subset of the creator's perms
      const requested = Array.isArray(item.permissions) ? item.permissions : [];
      // ensure all requested are strings
      for (const rp of requested) {
        if (typeof rp !== "string")
          return res
            .status(400)
            .json({ error: "permissions must be an array of strings" });
      }
      // If the request asks for the special "all" permission, do NOT store
      // the literal "all" string on the new API key. Instead expand it into
      // the full set of permissions the creator actually has. This avoids
      // giving a magic "all" token and keeps permissions explicit.
      let requestedProcessed = requested.slice();
      const wantsAll = requested.includes("all");
      if (wantsAll) {
        if (req.user?.is_api_key) {
          // For API-key-created keys, grant whatever permissions the API key
          // creator currently has.
          requestedProcessed = creatorPerms.slice();
        } else {
          // For user-role creators: if they are admin, derive the full list
          // of permissions from the role's can_* columns; otherwise grant
          // only the concrete permissions the role currently has.
          if (creatorIsAdmin) {
            requestedProcessed = Object.keys(roleRow)
              .filter((k) => k.startsWith("can_"))
              .map((k) => k.slice(4));
          } else {
            requestedProcessed = creatorPerms.slice();
          }
        }
      }

      // finalRequested must be a subset of the creator's concrete permissions
      // unless the creator is an admin (admins may grant any permissions).
      const finalRequested = requestedProcessed;
      if (!creatorIsAdmin) {
        const invalid = finalRequested.filter((p) => !creatorPerms.includes(p));
        if (invalid.length > 0) {
          return res.status(403).json({
            error: "Forbidden: cannot grant permissions you don't have",
            invalid_permissions: invalid,
          });
        }
      }

      // proceed to create key
      const raw = crypto.randomBytes(32).toString("hex");
      const keyHash = crypto.createHash("sha256").update(raw).digest("hex");
      const publicId = generatePublicIds("api_key");
      // Use the processed permissions (expanded 'all' -> explicit perms)
      const permsToStore = Array.isArray(item.permissions)
        ? // if we expanded above, use that; otherwise use the requested array
          requestedProcessed && requestedProcessed.length > 0
          ? requestedProcessed
          : item.permissions
        : [];
      const permsJson = JSON.stringify(permsToStore || []);
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
