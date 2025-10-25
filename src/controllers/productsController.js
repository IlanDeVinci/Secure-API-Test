import turso from "../db.js";
import dotenv from "dotenv";
import { z } from "zod";
import generatePublicIds from "../utils/generatePublicIds.js";
dotenv.config();

const SHOP_DOMAIN = "securedb-2.myshopify.com";
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const GRAPHQL_PATH = `/admin/api/2025-10/graphql.json`;

const productSchema = z.object({
  name: z.string().min(1),
  price: z.preprocess(
    (v) => (typeof v === "string" ? Number(v) : v),
    z.number().nonnegative()
  ),
  images: z.array(z.string().url()).optional(),
  // optional quantity to set inventory on Shopify only. Not persisted locally.
  // Accept numeric or string values; caller may omit and we'll default to 1.
  quantity: z.preprocess(
    (v) => (typeof v === "string" ? Number(v) : v),
    z.number().int().min(1).optional()
  ),
  // optional locationId (Shopify GID) to set inventory at. If omitted, defaults to
  // the store location GID used previously (gid://shopify/Location/77964902469).
  // Validate GID shape (e.g. gid://shopify/Location/77964902469) when provided.
  locationId: z
    .string()
    .regex(/^gid:\/\/shopify\/Location\/\d+$/, {
      message:
        "locationId must be a Shopify Location GID like gid://shopify/Location/12345",
    })
    .optional(),
});

// Helper that creates a single product on Shopify and records in database.
// Returns an object describing success or failure per item.
const createSingleProduct = async (productData, req) => {
  const parsed = productSchema.safeParse(productData);
  if (!parsed.success)
    return { success: false, error: z.treeifyError(parsed.error) };

  const { name, price } = parsed.data;
  const quantity =
    parsed.data.quantity != null ? Number(parsed.data.quantity) : 1;
  const locationId =
    parsed.data.locationId || "gid://shopify/Location/77964902469";

  if (!SHOPIFY_API_KEY)
    return { success: false, error: "Missing SHOPIFY_API_KEY in environment" };

  const url = `https://${SHOP_DOMAIN}${GRAPHQL_PATH}`;
  const productVar = { title: name };

  let mediaInput = null;
  if (Array.isArray(parsed.data.images) && parsed.data.images.length > 0) {
    mediaInput = parsed.data.images.map((src) => ({
      mediaContentType: "IMAGE",
      originalSource: src,
    }));
  }

  const createProductMutation = `mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {\n    productCreate(product: $product, media: $media) {\n      product { id title media(first: 10) { edges { node { ... on MediaImage { id image { url width height } alt } } } } }\n      userErrors { field message }\n    }\n  }`;

  let shopifyProduct;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API_KEY,
      },
      body: JSON.stringify({
        query: createProductMutation,
        variables: { product: productVar, media: mediaInput },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: "Shopify error", details: text };
    }

    const data = await resp.json();
    if (data.errors && data.errors.length) {
      return {
        success: false,
        error: "Shopify GraphQL error",
        details: data.errors,
      };
    }

    const payload = data.data?.productCreate;
    if (!payload)
      return {
        success: false,
        error: "Unexpected Shopify response",
        details: data,
      };
    if (payload.userErrors && payload.userErrors.length) {
      return {
        success: false,
        error: "Shopify user errors",
        details: payload.userErrors,
      };
    }

    shopifyProduct = payload.product;
  } catch (err) {
    return {
      success: false,
      error: "Shopify request failed",
      details: String(err),
    };
  }

  const gid = shopifyProduct.id || "";
  const shopifyId = String(gid).split("/").pop();
  const productName = shopifyProduct.title;
  let returnedImages = (shopifyProduct.media?.edges || [])
    .map((e) => e?.node?.image?.url)
    .filter(Boolean);

  if (price != null) {
    try {
      const variantsMutation = `mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n        productVariantsBulkCreate(productId: $productId, variants: $variants) {\n          productVariants { id price }\n          userErrors { field message }\n        }\n      }`;

      let variantEntry = {
        price: Number(price),
        optionValues: [{ name: String("Default"), optionName: "Title" }],
      };
      if (Number(quantity) > 0) {
        variantEntry.inventoryQuantities = [
          {
            availableQuantity: Number(quantity),
            locationId: locationId,
          },
        ];
      }
      const vResp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_API_KEY,
        },
        body: JSON.stringify({
          query: variantsMutation,
          variables: { productId: shopifyProduct.id, variants: [variantEntry] },
        }),
      });
      const vData = await vResp.json();
      if (vData.errors && vData.errors.length)
        console.warn("Variant mutation errors:", vData.errors);
      const bulkPayload = vData.data?.productVariantsBulkCreate;
      if (bulkPayload?.userErrors && bulkPayload.userErrors.length)
        console.warn("Variant user errors:", bulkPayload.userErrors);
    } catch (e) {
      console.warn("Variant bulk creation failed:", e);
    }
  }

  let publicId;
  try {
    publicId = generatePublicIds("product");
    const imagesJson = returnedImages.length
      ? JSON.stringify(returnedImages)
      : null;
    await turso.execute({
      sql: "INSERT INTO products (public_id, shopify_id, name, created_by, images) VALUES (?, ?, ?, ?, ?)",
      args: [publicId, shopifyId, productName, req.user.id, imagesJson],
    });
  } catch (err) {
    return {
      success: true,
      warning: "Created on Shopify; failed to record locally",
      shopify: shopifyProduct,
      local_error: err.message,
    };
  }

  // Background: poll missing media nodes and update DB
  (async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const mediaEdges = shopifyProduct.media?.edges || [];
      const missingMediaIds = mediaEdges
        .filter((e) => !e?.node?.image?.url && e?.node?.id)
        .map((e) => e.node.id);
      if (!missingMediaIds.length) return;

      const foundUrls = [];
      for (const mediaId of missingMediaIds) {
        let urlFound = null;
        for (let attempt = 0; attempt < 3 && !urlFound; attempt++) {
          if (attempt > 0) await delay(10000);
          const nodesQuery = `query getMediaNodes($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id image { url width height } alt } } }`;
          try {
            const nResp = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": SHOPIFY_API_KEY,
              },
              body: JSON.stringify({
                query: nodesQuery,
                variables: { ids: [mediaId] },
              }),
            });
            if (!nResp.ok) continue;
            const nData = await nResp.json();
            const node = nData.data?.nodes?.[0];
            const img = node?.image?.url;
            if (img) urlFound = img;
          } catch (e) {
            // ignore and retry
            console.warn("Error fetching media node:", e);
          }
        }
        if (urlFound) foundUrls.push(urlFound);
      }

      if (!foundUrls.length) return;

      const sel = await turso.execute({
        sql: "SELECT public_id, images FROM products WHERE shopify_id = ? LIMIT 1",
        args: [shopifyId],
      });
      const row = sel.rows[0];
      if (!row) return;
      const existing = row.images ? JSON.parse(row.images) : [];
      const merged = Array.from(new Set([...existing, ...foundUrls]));
      await turso.execute({
        sql: "UPDATE products SET images = ? WHERE shopify_id = ?",
        args: [JSON.stringify(merged), shopifyId],
      });
    } catch (e) {
      console.error("Error updating product images:", e);
    }
  })();

  return { success: true, public_id: publicId, shopify: shopifyProduct };
};

// Main createProduct: accept either a single product object or an array of products.
export const createProduct = async (req, res) => {
  const isArray = Array.isArray(req.body);
  if (!isArray) {
    const result = await createSingleProduct(req.body, req);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: result.error, details: result.details });
    }
    // Created but with warning (DB failure)
    if (result.warning) {
      return res.status(201).json({
        message: result.warning,
        shopify: result.shopify,
        local_error: result.local_error,
      });
    }
    return res.status(201).json({
      message: "Product created",
      public_id: result.public_id,
      shopify: result.shopify,
    });
  }

  // Array: process sequentially and collect per-item results
  const items = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({
      error: "Request body must be a non-empty array or a product object",
    });

  const results = [];
  for (const item of items) {
    // createSingleProduct returns either success:true or success:false
    try {
      // attach user to mimic single flow
      const r = await createSingleProduct(item, req);
      results.push(r);
    } catch (e) {
      results.push({ success: false, error: String(e) });
    }
  }

  const allSuccess = results.every((r) => r.success === true);
  const status = allSuccess ? 201 : 207; // 207 Multi-Status when partial failures occur
  return res.status(status).json({ results });
};

// List products created by the logged-in user
export const getMyProducts = async (req, res) => {
  try {
    // Return only public-facing fields. Replace created_by numeric id with user's public_id.
    const result = await turso.execute({
      sql: `SELECT p.public_id, p.shopify_id, p.name, p.images, u.public_id AS created_by_public_id
            FROM products p
            JOIN users u ON p.created_by = u.id
            WHERE p.created_by = ?`,
      args: [req.user.id],
    });
    // map to consistent property names and parse images JSON
    const rows = result.rows.map((r) => ({
      public_id: r.public_id,
      shopify_id: r.shopify_id,
      name: r.name,
      images: r.images ? JSON.parse(r.images) : [],
      created_by: r.created_by_public_id,
    }));
    res.json(rows);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to fetch user's products", details: err.message });
  }
};

// List all products
export const getProducts = async (req, res) => {
  try {
    const result = await turso.execute({
      sql: `SELECT p.public_id, p.shopify_id, p.name, p.images, u.public_id AS created_by_public_id
            FROM products p
            JOIN users u ON p.created_by = u.id`,
    });
    const rows = result.rows.map((r) => ({
      public_id: r.public_id,
      shopify_id: r.shopify_id,
      name: r.name,
      images: r.images ? JSON.parse(r.images) : [],
      created_by: r.created_by_public_id,
    }));
    res.json(rows);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to fetch products", details: err.message });
  }
};

// Premium users: return the user's products sorted by sales_count desc
export const getMyBestsellers = async (req, res) => {
  try {
    // ensure user is premium
    const roleRes = await turso.execute({
      sql: "SELECT name FROM roles WHERE id = ? LIMIT 1",
      args: [req.user.role_id],
    });
    const roleName = roleRes.rows[0]?.name;
    if (roleName !== "premium") {
      return res.status(403).json({ error: "Requires premium role" });
    }

    const result = await turso.execute({
      sql: `SELECT p.name, p.public_id, p.shopify_id, COALESCE(p.sales_count,0) AS sales_count
            FROM products p
            WHERE p.created_by = ?
            ORDER BY COALESCE(p.sales_count,0) DESC`,
      args: [req.user.id],
    });
    res.json(
      result.rows.map((r) => ({
        name: r.name,
        public_id: r.public_id,
        shopify_id: r.shopify_id,
        sales_count: r.sales_count,
      }))
    );
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to fetch bestsellers", details: err.message });
  }
};
