import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import { env } from "./config/env.js";
import apiRoutes from "./routes/index.js";
import integrationWebhookRoutes from "./routes/integrationWebhook.routes.js";
import { errorHandler } from "./middleware/error.middleware.js";
import { initSocket } from "./socket/index.js";
import { connectDatabase } from "./config/database.js";
import { requireDatabase } from "./middleware/database.middleware.js";

const app = express();

const server = http.createServer(app);

// Initialize Socket.io with the HTTP server
initSocket(server);

app.disable("x-powered-by");

app.use(helmet());

const allowedOrigins = [
  "http://localhost:5173",
  "http://3.24.190.193",
  "https://apex-crm-xi.vercel.app",
  "https://www.dealqix.com",
  "https://dealqix.com",
  env.clientUrl,
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an origin (Postman, server-to-server, etc.)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(
  express.json({
    limit: "1mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "1mb",
  }),
);

app.use(cookieParser());

// Liveness only: this deliberately does not claim database readiness.
app.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ success: true, service: "crm-api", check: "liveness" });
});

// Vercel imports the Express app, rather than invoking src/server.ts.
// Keep the existing AWS listener/startup unchanged.
if (process.env.VERCEL === "1") {
  app.use("/api/v1", requireDatabase(connectDatabase));
}

// Provider webhooks go before the logger and the global limiter: the URL
// carries a secret that must not reach access logs (see the route file).
app.use("/api/v1/integrations/webhooks", integrationWebhookRoutes);

app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));

const globalRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

app.use(globalRateLimiter);

app.use("/api/v1", apiRoutes);
app.use(errorHandler);

export default app;
