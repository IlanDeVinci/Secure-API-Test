#!/usr/bin/env node
import fs from "fs";
import path from "path";
import readline from "readline";

function parseRawHttp(text) {
  // Normalize line endings
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0) return null;

  const startLine = lines[0].trim();
  const [method, rawPath] = startLine.split(" ");

  const headers = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      break;
    }
    const idx = line.indexOf(":");
    if (idx > -1) {
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      headers[name.toLowerCase()] = value;
    }
  }

  const bodyLines = lines.slice(i);
  const body = bodyLines.join("\n").trim();

  return { method, path: rawPath, headers, body };
}

function makePostmanCollection(parsed, collectionName = "Converted Request") {
  const headersArray = Object.entries(parsed.headers).map(([k, v]) => ({
    key: k,
    value: v,
  }));

  // Determine host + protocol
  const hostHeader =
    parsed.headers["host"] ||
    parsed.headers["x-forwarded-host"] ||
    parsed.headers["x-shopify-shop-domain"] ||
    "localhost";
  const scheme =
    parsed.headers["x-forwarded-proto"] ||
    (hostHeader.startsWith("localhost") ? "http" : "https");
  const fullUrl = `${scheme}://${hostHeader}${parsed.path}`;

  // Build url object for Postman (simple)
  const hostParts = hostHeader.split(".");
  const pathParts = parsed.path.replace(/^\//, "").split("/").filter(Boolean);

  const bodyMode =
    parsed.headers["content-type"] &&
    parsed.headers["content-type"].includes("application/json")
      ? "raw"
      : "raw";
  const rawBody = parsed.body || "";

  const collection = {
    info: {
      name: collectionName,
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: `${parsed.method} ${parsed.path}`,
        request: {
          method: parsed.method,
          header: headersArray.map((h) => ({ key: h.key, value: h.value })),
          body: {
            mode: bodyMode,
            raw: rawBody,
            options: {
              raw: {
                language:
                  parsed.headers["content-type"] &&
                  parsed.headers["content-type"].includes("application/json")
                    ? "json"
                    : "text",
              },
            },
          },
          url: {
            raw: fullUrl,
            protocol: scheme,
            host: hostParts,
            path: pathParts,
          },
        },
      },
    ],
  };

  return collection;
}

function makeCurl(parsed) {
  const hostHeader =
    parsed.headers["host"] ||
    parsed.headers["x-forwarded-host"] ||
    parsed.headers["x-shopify-shop-domain"] ||
    "localhost";
  const scheme =
    parsed.headers["x-forwarded-proto"] ||
    (hostHeader.startsWith("localhost") ? "http" : "https");
  const url = `${scheme}://${hostHeader}${parsed.path}`;

  const headerParts = Object.entries(parsed.headers)
    .map(([k, v]) => `-H "${k}: ${v}"`)
    .join(" ");

  // Escape body safely for a double-quoted string
  const rawBody = parsed.body || "";
  const escapedBody = rawBody.replace(/"/g, '\\"');

  const curl = `curl -X ${parsed.method} ${headerParts} --data-raw "${escapedBody}" "${url}"`;
  return curl;
}

async function main() {
  const args = process.argv.slice(2);
  let input = "";

  if (args.length > 0 && args[0] !== "-") {
    // Read from file path argument
    const filePath = path.resolve(process.cwd(), args[0]);
    input = fs.readFileSync(filePath, "utf8");
  } else if (args.length > 0 && args[0] === "-") {
    // Read from piped stdin (non-interactive)
    input = await new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
    });
  } else {
    // Interactive paste mode: user runs `npm run http-to-postman` with no args
    // Finish only when the user types EOF on its own line. This avoids accidental termination.
    console.log(
      "Paste the raw HTTP request below. When finished, type a single line with only EOF and press Enter."
    );
    input = await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const lines = [];
      rl.on("line", (line) => {
        if (line === "EOF") {
          rl.close();
        } else {
          lines.push(line);
        }
      });
      rl.on("close", () => resolve(lines.join("\n")));
    });
  }

  if (!input || input.trim() === "") {
    console.error(
      "No input provided. Pass a file path or pipe the raw HTTP request into the script."
    );
    process.exit(2);
  }

  const parsed = parseRawHttp(input);
  if (!parsed) {
    console.error("Failed to parse input");
    process.exit(3);
  }

  const collection = makePostmanCollection(parsed, "Converted HTTP Request");
  const curl = makeCurl(parsed);

  const outDir = path.resolve(process.cwd(), "scripts");
  const collectionPath = path.join(outDir, "postman-collection.json");
  fs.writeFileSync(collectionPath, JSON.stringify(collection, null, 2), "utf8");

  console.log("Wrote Postman collection to:", collectionPath);
  console.log("\ncURL command:");
  console.log(curl);
  console.log("\nPostman collection JSON (snippet):");
  console.log(JSON.stringify(collection.item[0], null, 2));
}

// Run main when executed directly
main();
