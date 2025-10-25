import crypto from "crypto";

/**
 * Generate a stable-looking public id for an entity.
 * Example: user_5f2d9a7e9b3c
 * Keep it short, URL-safe, and unique enough for public lookups.
 *
 * @param {string} entityType
 * @returns {string}
 */
export default function generatePublicIds(entityType = "obj") {
  const prefix = String(entityType).replace(/\s+/g, "_").toLowerCase();
  // 8 bytes -> 16 hex chars
  const hex = crypto.randomBytes(8).toString("hex");
  return `${prefix}_${hex}`;
}
