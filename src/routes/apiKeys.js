import express from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import {
  createApiKeys,
  listApiKeys,
  deleteApiKeys,
} from "../controllers/apiKeysController.js";

const router = express.Router();

// Admin-only: create one or many API keys (each item has name + optional permissions array)
router.post("/api-keys", auth, requireRole(["create_api_keys"]), createApiKeys);

// Admin-only: list API keys created by the logged-in admin
router.get("/api-keys", auth, requireRole(["read_api_keys"]), listApiKeys);

// Admin-only: delete one-or-many api keys (body: { public_ids: ["pub_abc","pub_def"] })
router.delete(
  "/api-keys",
  auth,
  requireRole(["delete_api_keys"]),
  deleteApiKeys
);

export default router;
