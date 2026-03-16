import "./tracing";
import express, { Request, Response, NextFunction } from "express";
import http from "http";
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

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:5173,http://localhost:8086"
)
  .split(",")
  .map((o) => o.trim());

const BFF_HOST = "grainguard-bff";
const BFF_PORT = 4000;

/**
 * Helmet
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: [
          "'self'",
          "http://localhost:5173",
          "http://localhost:8086",
          "ws://localhost:8086",
        ],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

/**
 * CORS
 */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for ${origin}`));
    },
    credentials: true,
  })
);

app.use(requestIdMiddleware);

/**
 * Latency metric
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const end = requestLatency.startTimer();
  res.on("finish", () => end());
  next();
});

/**
 * Request log
 */
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(
    JSON.stringify({
      level: "info",
      service: "gateway",
      request_id: req.requestId,
      method: req.method,
      path: req.path,
      origin: req.headers.origin,
      timestamp: new Date().toISOString(),
    })
  );
  next();
});

/**
 * GraphQL Reverse Proxy — manual node http proxy (bypasses hpm v3 issues)
 */
app.use("/graphql", (req: Request, res: Response) => {
  const headers: Record<string, string | string[]> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (val !== undefined) headers[key] = val;
  }
  headers["host"] = `${BFF_HOST}:${BFF_PORT}`;

  const options: http.RequestOptions = {
    hostname: BFF_HOST,
    port: BFF_PORT,
    path: "/graphql",
    method: req.method,
    headers,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers as any);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("[graphql-proxy] error:", err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: "Bad gateway" });
    }
  });

  req.pipe(proxyReq, { end: true });
});

/**
 * REST routes — express.json() applied only here
 */
app.post(
  "/devices",
  express.json({ limit: "10kb" }),
  apiRateLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { serialNumber } = req.body;
      if (!serialNumber)
        return res.status(400).json({ error: "Missing serialNumber" });

      const tenantId = req.user!.tenantId;
      const userId = req.user!.sub;
      const requestId = String(req.requestId);

      const authHeader = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization;

      const result = await createDevice(
        tenantId,
        serialNumber,
        requestId,
        userId,
        authHeader
      );

      return res.json(result);
    } catch (err) {
      console.error(err);
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
      const data = await getDeviceLatestTelemetry(req.params.deviceId);
      if (!data) return res.status(404).json({ error: "Not found" });
      return res.json(data);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/metrics", metricsHandler());

process.on("SIGTERM", async () => {
  await redis.quit();
  await pool.end();
  process.exit(0);
});

const PORT = parseInt(process.env.PORT || "3000");

const server = http.createServer(app);

/**
 * WebSocket upgrade — pipe directly to BFF for GraphQL subscriptions
 */
server.on("upgrade", (req, socket, head) => {
  const proxyReq = http.request({
    hostname: BFF_HOST,
    port: BFF_PORT,
    path: "/graphql",
    method: req.method,
    headers: req.headers,
  });

  proxyReq.on("upgrade", (_proxyRes, proxySocket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n\r\n"
    );
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("error", (err) => {
    console.error("[ws-proxy] error:", err.message);
    socket.destroy();
  });

  proxyReq.end();
});

server.listen(PORT, () => {
  console.log(`Gateway running on ${PORT}`);
});