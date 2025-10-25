import express from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import {
  createProduct,
  getMyProducts,
  getProducts,
  getMyBestsellers,
} from "../controllers/productsController.js";
import { handleShopifyOrderCreate } from "../controllers/webhooksController.js";

const router = express.Router();

// Create product (Shopify + local record).
// If the request includes images, require the additional permission `can_upload_media`.
const requireUploadIfImages = (req, res, next) => {
  // If body is an array of products, require upload permission when any item contains images.
  if (Array.isArray(req.body)) {
    const anyHasImages = req.body.some(
      (item) => item && Array.isArray(item.images) && item.images.length > 0
    );
    if (anyHasImages) return requireRole(["upload_media"])(req, res, next);
    return next();
  }

  if (
    req.body &&
    Array.isArray(req.body.images) &&
    req.body.images.length > 0
  ) {
    // `requireRole` expects permission names like 'upload_media' -> role column `can_upload_media`
    return requireRole(["upload_media"])(req, res, next);
  }
  return next();
};

router.post(
  "/products",
  auth,
  requireRole(["post_products"]),
  requireUploadIfImages,
  createProduct
);

// Get products created by the logged-in user (requires can_get_my_products)
router.get(
  "/my-products",
  auth,
  requireRole(["get_my_products"]),
  getMyProducts
);

// Premium users: get your products sorted by sales_count desc
router.get(
  "/my-bestsellers",
  auth,
  requireRole(["get_bestsellers"]),
  getMyBestsellers
);

// Get all products (requires can_get_products)
router.get("/products", auth, requireRole(["get_products"]), getProducts);

// Shopify webhook for new orders: public endpoint, verifies HMAC & updates sales_count
router.post("/webhooks/shopify-sales", handleShopifyOrderCreate);

export default router;
