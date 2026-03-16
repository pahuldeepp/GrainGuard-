import "./tracing";
import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { createDevice } from "./services/device";
import { getDeviceLatestTelemetry } from "./services/device-query";
import { redis } from "./cache/redis";
import { pool } from "./database/db";
import { metricsHandler, requestLatency } from "./observability/metrics";
import { requestIdMiddleware } from "./middleware/requestId";
import { authMiddleware } from "./middleware/auth";
import { apiRateLimiter } from "./middleware/rateLimiting";

const app = express();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",");

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-request-id"],
  exposedHeaders: ["x-request-id", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
  credentials: true,
  maxAge: 86400,
}));

app.use(express.json({ limit: "10kb" }));
app.use(requestIdMiddleware);

app.use((req, res, next) => {
  const end = requestLatency.startTimer();
  res.on("finish", () => end());
  next();
});

app.use((req, _res, next) => {
  console.log(JSON.stringify({
    level: "info",
    service: "gateway",
    request_id: req.requestId,
    method: req.method,
    path: req.path,
    origin: req.headers.origin,
    timestamp: new Date().toISOString(),
  }));
  next();
});

app.post(
  "/devices",
  apiRateLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { serialNumber } = req.body;
      if (!serialNumber) {
        return res.status(400).json({ error: "Missing serialNumber" });
      }
      const tenantId = req.user!.tenantId;
      const userId = req.user!.sub;
      const token = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization;
      const requestId = Array.isArray(req.requestId)
        ? req.requestId[0]
        : req.requestId;
      const result = await createDevice(tenantId, serialNumber, requestId, userId, token);
      return res.json(result);
    } catch (err) {
      console.error(JSON.stringify({
        level: "error",
        service: "gateway",
        request_id: req.requestId,
        error: String(err),
        path: req.path,
      }));
      return res.status(500).json({ error: "Failed to create device" });
    }
  }
);

app.get(
  "/devices/:deviceId/latest",
  apiRateLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const data = await getDeviceLatestTelemetry(req.params["deviceId"] as string);
      if (!data) return res.status(404).json({ error: "Not found" });
      return res.json(data);
    } catch (err) {
      console.error(JSON.stringify({
        level: "error",
        service: "gateway",
        request_id: req.requestId,
        error: String(err),
        path: req.path,
      }));
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/metrics", metricsHandler());

process.on("SIGTERM", async () => {
  console.log(JSON.stringify({ level: "info", service: "gateway", message: "Shutting down..." }));
  await redis.quit();
  await pool.end();
  process.exit(0);
});

const PORT = parseInt(process.env.PORT || "3000");

app.listen(PORT, () => {
  console.log(JSON.stringify({
    level: "info",
    service: "gateway",
    message: `Gateway running on port ${PORT}`,
    allowedOrigins: ALLOWED_ORIGINS,
  }));
});
