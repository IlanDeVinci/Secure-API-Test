# http-to-postman

This small CLI converts a raw HTTP request (headers + body) into a Postman collection JSON and prints a cURL equivalent.

Usage

1. Convert a sample file (written to `scripts/postman-collection.json`)

```bash
npm run http-to-postman -- scripts/sample-request.txt
```

2. Pipe a request into the tool

```powershell
type scripts\sample-request.txt | npm run http-to-postman -- -
```

3. Interactive paste mode (no args)

Run the command with no arguments and paste the entire raw HTTP request into the terminal. When finished, type a single line containing only EOF and press Enter to finish the paste.

```bash
npm run http-to-postman
```

Then paste the request and finish by typing:

```
EOF
```

Output

- `scripts/postman-collection.json` — Postman collection (v2.1.0) with a single request
- The CLI prints a recommended cURL command and a snippet of the Postman request

Notes

- The tool uses `Host`, `X-Forwarded-Host`, or `X-Shopify-Shop-Domain` to construct the URL and `X-Forwarded-Proto` for protocol when available.
- Body is treated as raw text; if `Content-Type` contains `application/json`, the Postman body language is set to `json`.
