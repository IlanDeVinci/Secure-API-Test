# Secure API Test

Small Express API that integrates with Shopify and a Turso (SQLite-compatible) DB. This README gives a concise setup guide, explains the main endpoints (including the bulk product upload), and highlights important permission/behavior notes.

## Repo layout

- `src/` - application source
  - `controllers/` - route handlers (products, users, auth, webhooks, api-keys)
  - `routes/` - Express routes
  - `middleware/` - auth and roles checks
  - `db.js` - Turso database helper
  - `index.js` - app entry (mounts API at `/api`)
- `migrations/` - DB init SQL
- `scripts/` - helper scripts (postman conversion, samples)

## Quick start

1. Copy `.env.example` to `.env` and set required values:
   - `SHOPIFY_API_KEY` - Shopify Admin access token for the store
   - any DB connection env vars used by `src/db.js`
2. Install dependencies:

```powershell
npm install
```

3. Run the app:

```powershell
npm start
```

By default the app mounts routes under the `/api` prefix (e.g. `POST /api/products`).

## Database initialization

Run the SQL in `migrations/dbinit.sql` against your SQLite/Turso DB to create tables and seed basic roles. Example using sqlite3:

```powershell
sqlite3 ./mydb.sqlite < migrations/dbinit.sql
```

## Authentication & permissions

- Requests use either API keys (via `x-api-key`) or JWT Authorization (`Authorization: Bearer <token>`).
- Roles and permission flags are seeded in `migrations/dbinit.sql`. Permissions are exposed as flags like `can_post_products`, `can_upload_media`, etc. The middleware maps permission names to role columns.

## Main endpoints

All endpoints below are mounted under `/api`.

- POST /api/products — create a product (Shopify + local record). Requires `post_products` permission.
- POST /api/products (bulk) — send an array of product objects to create multiple products in one request (see details below).
- GET /api/products — list all products (requires `get_products`).
- GET /api/my-products — list products created by the logged-in user (requires `get_my_products`).
- GET /api/my-bestsellers — premium users only (requires `get_bestsellers`).
- POST /api/webhooks/shopify-sales — public webhook endpoint to update `sales_count` (verifies HMAC).

Other user & admin routes:

- POST /register — register new user (no auth). Body: `username`, `password`, `email`, optional `role`.
- POST /login — login (rate-limited). Body: `username`, `password`.
- GET /api-keys — list API keys (requires `read_api_keys`).
- POST /api-keys — create API key(s) (requires `create_api_keys`). Body: single object or array: `{ name, permissions? }`.
- DELETE /api-keys — delete API keys (requires `delete_api_keys`). Body: `{ public_ids: [...] }`.

See the `routes/` and `controllers/` folders for the exact behavior and permission checks.

## POST /api/products (single & bulk)

This endpoint accepts either a single product object or an array of product objects.

Product object fields (validated):

- `name` (string, required)
- `price` (number | numeric string, required)
- `images` (array of image URLs, optional)
- `quantity` (integer >= 1, optional) — used to set starting inventory on Shopify only (defaults to `1` if omitted)
- `locationId` (string, optional) — Shopify location GID (e.g. `gid://shopify/Location/77964902469`). If omitted a sensible default is used.

Permission note: if any product in a bulk request includes a non-empty `images` array, the request requires the `upload_media` permission.

Responses:

- Single-object: HTTP 201 on success (returns `{ message: "Product created", public_id, shopify }`).
- Array request: HTTP 201 if all items succeeded; HTTP 207 (Multi-Status) if one or more items failed. The response body for array requests is `{ "results": [ ... ] }` with per-item result objects.

Sample multi-product payload (also used in examples above):

```json
[
  {
    "name": "Classic Tee",
    "price": 19.99,
    "images": ["https://example.com/img/classic-tee.jpg"],
    "quantity": 10,
    "locationId": "gid://shopify/Location/77964902469"
  },
  {
    "name": "Canvas Tote",
    "price": "12.5",
    "images": [],
    "quantity": "5"
  },
  {
    "name": "Sticker Pack",
    "price": 4.0
  },
  {
    "name": "",
    "price": 5.0
  },
  {
    "name": "Limited Poster",
    "price": 25,
    "images": [
      "https://example.com/img/poster1.jpg",
      "https://example.com/img/poster2.jpg"
    ]
  }
]
```

PowerShell example to POST the file (replace token and URL):

```powershell
$body = Get-Content -Raw -Path .\scripts\multi-products-sample.json
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/products' -Body $body -ContentType 'application/json' -Headers @{ Authorization = 'Bearer <token>' }
```

curl example:

```bash
curl -X POST http://localhost:3000/api/products \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  --data-binary @scripts/multi-products-sample.json
```

The sample payload includes one intentionally-invalid item (empty `name`) to demonstrate partial failures.

## Notes about `quantity`

The `quantity` field sets the initial stock level for the default variant created on Shopify. The server:

- accepts `quantity` (or defaults to `1`)
- includes that quantity in the variant creation GraphQL payload sent to Shopify
- does NOT persist the quantity locally (Shopify is authoritative for inventory)

## Roles, permissions & DB seeds

The `migrations/dbinit.sql` file seeds roles (admin, user, premium, ban) and permission flags (columns like `can_post_products`, `can_upload_media`). Review that file to understand which permissions each role receives by default.

## Troubleshooting

- If you hit Shopify API rate limits while bulk-creating many items, consider batching requests or adding retries with backoff.
- For auth errors, the middleware returns structured messages; ensure your token or API key is valid and that the user role includes the required permission.
