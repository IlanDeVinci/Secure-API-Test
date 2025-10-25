import crypto from "crypto";
import { z } from "zod";
import turso from "../db.js";

const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

// Schema: minimal validation of Shopify order create payload we need
const lineItemSchema = z
  .object({
    // accept product_id or variant_id (both may come as string or number)
    product_id: z
      .preprocess(
        (v) => (typeof v === "string" ? Number(v) : v),
        z.number().int().positive()
      )
      .optional(),
    variant_id: z
      .preprocess(
        (v) => (typeof v === "string" ? Number(v) : v),
        z.number().int().positive()
      )
      .optional(),
    quantity: z.preprocess(
      (v) => (typeof v === "string" ? Number(v) : v),
      z.number().int().nonnegative()
    ),
  })
  .refine((obj) => Boolean(obj.product_id || obj.variant_id), {
    message: "line item must include product_id or variant_id",
  });

const orderSchema = z.object({
  id: z.preprocess(
    (v) => (typeof v === "string" ? Number(v) : v),
    z.number().int()
  ),
  line_items: z.array(lineItemSchema).min(1),
});

/**
 * Shopify order create webhook handler.
 * Verifies HMAC (x-shopify-hmac-sha256) against raw body, validates payload,
 * then increments products.sales_count by quantity for matching shopify_id.
 */
export const handleShopifyOrderCreate = async (req, res) => {
  try {
    if (!webhookSecret) {
      console.error("SHOPIFY_WEBHOOK_SECRET missing from env");
      return res
        .status(500)
        .json({ error: "Missing SHOPIFY_WEBHOOK_SECRET in env" });
    }

    // Prefer req.get for a single string value; Express normalizes header names
    const header =
      req.get("x-shopify-hmac-sha256") || req.get("X-Shopify-Hmac-Sha256");
    if (!header) {
      console.warn("Missing HMAC header in request", {
        headersSample: Object.keys(req.headers).slice(0, 10),
      });
      return res.status(401).json({ error: "Missing HMAC header" });
    }

    // Try to get raw body (Buffer or string). If middleware didn't provide rawBody,
    // fall back to a Buffer built from req.body (best-effort).
    let raw = req.rawBody;
    if (!raw) {
      if (typeof req.body === "string") {
        raw = Buffer.from(req.body, "utf8");
      } else if (Buffer.isBuffer(req.body)) {
        raw = req.body;
      } else if (req.body && typeof req.body === "object") {
        // fallback: stringify parsed body — may differ from original bytes but often works
        try {
          raw = Buffer.from(JSON.stringify(req.body), "utf8");
        } catch (e) {
          raw = null;
        }
      }
    } else {
      console.log("Using req.rawBody (length:", raw.length + ")");
    }

    if (!raw || !(raw instanceof Buffer)) {
      console.error(
        "Missing raw body for HMAC verification; cannot verify signature",
        {
          rawPresent: !!raw,
          reqBodyType: typeof req.body,
        }
      );
      return res.status(400).json({
        error: "Missing raw body for HMAC verification",
        details: {
          hint: "Ensure your body-parser is configured to capture raw body (use verify option to store raw buffer on req.rawBody).",
          reqBodyType: typeof req.body,
        },
      });
    }

    // compute HMAC base64
    const computed = crypto
      .createHmac("sha256", webhookSecret)
      .update(raw)
      .digest("base64");

    // Compare using raw bytes decoded from base64 to avoid encoding/length issues
    let headerBuf, computedBuf;
    try {
      // header from Shopify is base64; decode into bytes
      headerBuf = Buffer.from(String(header), "base64");
      computedBuf = Buffer.from(computed, "base64");
    } catch (e) {
      console.error(
        "Failed to decode HMAC header or computed HMAC as base64:",
        e,
        { header }
      );
      return res.status(401).json({
        error: "Invalid HMAC header encoding",
        details:
          "Header could not be decoded as base64. Check header value and ensure Shopify is sending x-shopify-hmac-sha256.",
      });
    }

    if (
      headerBuf.length !== computedBuf.length ||
      !crypto.timingSafeEqual(headerBuf, computedBuf)
    ) {
      console.warn("HMAC signature mismatch", {
        headerBase64: String(header).slice(0, 64),
        computedBase64: computed.slice(0, 64),
        headerLen: headerBuf.length,
        computedLen: computedBuf.length,
      });
      return res.status(401).json({
        error: "Invalid HMAC signature",
        details: {
          hint: "Signature did not match. Common causes: wrong webhook secret, raw body modified by middleware, or header altered.",
          headerLength: headerBuf.length,
          computedLength: computedBuf.length,
        },
      });
    }

    // Parse JSON safely (bodyParser.json already parsed, but validate using the parsed body)
    const payload = req.body;
    const parsed = orderSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("Payload validation failed:", z.treeifyError(parsed.error));
      return res.status(400).json({
        error: "Invalid payload",
        details: z.treeifyError(parsed.error),
        hint: "Check that the webhook payload includes order id and line_items with product_id/variant_id and quantity.",
      });
    }

    const order = parsed.data;

    // For each line item, increment sales_count by quantity where shopify_id matches product_id or variant_id
    const updates = [];
    for (const li of order.line_items) {
      // prefer product_id, fall back to variant_id
      const idSource = li.product_id ?? li.variant_id;
      const productIdStr = String(idSource);
      const qty = li.quantity || 0;
      if (qty <= 0) continue;

      try {
        await turso.execute({
          sql: "UPDATE products SET sales_count = COALESCE(sales_count, 0) + ? WHERE shopify_id = ?",
          args: [qty, productIdStr],
        });
        updates.push({ shopify_id: productIdStr, added: qty });
      } catch (err) {
        console.error(
          "DB update failed for shopify_id:",
          productIdStr,
          "error:",
          err
        );
        // continue processing other items but record error
        updates.push({
          shopify_id: productIdStr,
          added: 0,
          error: err.message,
        });
      }
    }

    return res.status(200).json({
      message: "Processed order webhook",
      order_id: order.id,
      updates,
    });
  } catch (err) {
    console.error("Webhook processing failed:", err);
    return res
      .status(500)
      .json({ error: "Webhook processing failed", details: String(err) });
  }
};
