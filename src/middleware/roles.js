import turso from "../db.js";

/**
 * @typedef {{ id:number; username:string }} ReqUser
 */

export const requireRole = (allowedRoles) => {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    // If this is an API key, evaluate permissions from req.user.permissions
    if (req.user.is_api_key) {
      const perms = Array.isArray(req.user.permissions)
        ? req.user.permissions
        : [];

      for (const reqPerm of allowedRoles) {
        if (typeof reqPerm !== "string") continue;

        if (reqPerm.startsWith("role:")) {
          // API keys cannot satisfy role checks
          continue;
        }

        // permission name expected like "get_products" etc.
        if (perms.includes(reqPerm) || perms.includes("all")) {
          return next();
        }
      }

      return res
        .status(403)
        .json({ error: "Forbidden: insufficient permissions (api key)" });
    }

    const result = await turso.execute({
      sql: "SELECT r.*, r.name AS role_name FROM roles r JOIN users u ON u.role_id = r.id WHERE u.id = ?",
      args: [req.user.id],
    });
    const rolePermissions = result.rows[0];

    if (
      !rolePermissions ||
      (rolePermissions.role_name &&
        rolePermissions.role_name.toLowerCase() === "ban")
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    for (const reqPerm of allowedRoles) {
      if (typeof reqPerm !== "string") continue;

      if (reqPerm.startsWith("role:")) {
        const wantedRole = reqPerm.slice(5).toLowerCase();
        if ((rolePermissions.role_name || "").toLowerCase() === wantedRole)
          return next();
        continue;
      }

      const col = `can_${reqPerm}`;
      const val = rolePermissions[col];

      // accept numeric 1, string "1", "TRUE", boolean true
      if (
        val === 1 ||
        val === "1" ||
        val === true ||
        String(val).toUpperCase() === "TRUE"
      ) {
        return next();
      }
    }

    return res
      .status(403)
      .json({ error: "Forbidden: insufficient permissions" });
  };
};
