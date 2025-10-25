import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import productRoutes from "./routes/products.js";
import apiKeysRoutes from "./routes/apiKeys.js";

dotenv.config();

const app = express();

// Capture raw body buffer for HMAC verification (used by Shopify webhook)
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // store Buffer for signature verification
    },
  })
);

// Health check
app.get("/health", (req, res) => res.json({ test: "hello world" }));

// Routes
app.use("/api", authRoutes);
app.use("/api", userRoutes);
app.use("/api", productRoutes);
app.use("/api", apiKeysRoutes);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT} (http://localhost:${PORT})`)
);
