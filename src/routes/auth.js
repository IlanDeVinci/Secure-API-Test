import express from "express";
import { z } from "zod";
import { limitLoginAttempts } from "../utils/rateLimit.js";
import { register, login } from "../controllers/authController.js";

const router = express.Router();

const registerSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
  email: z.string().email(),
  role: z.string().optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// Register user
router.post("/register", (req, res, next) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: z.treeifyError(parsed.error) });
  req.body = parsed.data;
  return register(req, res, next);
});

// Login user (with rate limit)
router.post("/login", limitLoginAttempts, (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: z.treeifyError(parsed.error) });
  req.body = parsed.data;
  return login(req, res, next);
});

export default router;
