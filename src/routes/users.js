import express from "express";
import { z } from "zod";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import {
  getMyUser,
  getUsers,
  changePassword,
  changeRole,
} from "../controllers/usersController.js";

const router = express.Router();

const changePasswordSchema = z.object({
  password: z.string().min(6),
});

const changeRoleSchema = z.object({
  userPublicId: z.string().min(1),
  newRole: z.string().min(1),
});

// Get my user info
router.get("/my-user", auth, requireRole(["get_my_user"]), getMyUser);

// Get all users (admin only)
router.get("/users", auth, requireRole(["get_users"]), getUsers);

// Change password and expire JWT immediately
router.post("/change-password", auth, (req, res, next) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: z.treeifyError(parsed.error) });
  req.body = parsed.data;
  return changePassword(req, res, next);
});

// Change user role (admin only)
router.post(
  "/change-role",
  auth,
  requireRole(["role:admin"]),
  (req, res, next) => {
    const parsed = changeRoleSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: z.treeifyError(parsed.error) });
    req.body = parsed.data;
    return changeRole(req, res, next);
  }
);

export default router;
