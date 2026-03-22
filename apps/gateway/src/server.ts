import "./tracing";
import express, { Request, Response, NextFunction } from "express";
import http from "http";
import helmet from "helmet";
import cors from "cors";
import { createDevice } from "./services/device";
import { getDeviceLatestTelemetry } from "./services/device-query";
import { redis } from "./cache/redis";
import { pool } from "./database/db";
import { logAuditEvent, writePool } from "./lib/audit";
import { metricsHandler, requestLatency } from "./observability/metrics";
import { requestIdMiddleware } from "./middleware/requestId";
import { authMiddleware } from "./middleware/auth";
import { apiKeyMiddleware } from "./middleware/apiKey";
import { apiRateLimiter } from "./middleware/rateLimiting";
import { validate, createDeviceSchema, deviceIdParamSchema } from "./middleware/validation";
import { apiVersionMiddleware } from "./middleware/apiVersion";
import { securityHeaders, permissionsPolicy } from "./middleware/securityHeaders";
import { csrfProtection } from "./middleware/csrf";
import { billingRouter } from "./routes/billing";
import { tenantsRouter } from "./routes/tenants";

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
 * Security headers — replaces the old inline helmet() call with our
 * hardened securityHeaders() + permissionsPolicy() middleware pair.
 * securityHeaders() pins CSP, HSTS, noSniff, referrerPolicy, etc.
 * permissionsPolicy() disables camera/mic/GPS/payment/USB browser APIs.
 */
app.use(securityHeaders());
app.use(permissionsPolicy());

/**
 * Stripe webhook — MUST receive the raw Buffer body so that
 * stripe.webhooks.constructEvent() can verify the HMAC signature.
 * Mount BEFORE express.json() so this route is not body-parsed as JSON.
 */
app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }), // raw Buffer — not parsed
  (req, res, next) => {
    // Forward raw body to the billing router
    next();
  }
);

/**
 * CSRF protection — applies to all mutating routes (POST/PUT/PATCH/DELETE)
 * except the Stripe webhook (webhook caller is Stripe, not a browser).
 * GET/HEAD/OPTIONS are safe by definition and just issue a fresh token.
 */
app.use(csrfProtection());

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
app.use(apiVersionMiddleware);

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
 * Billing + Tenant REST routes
 * billingRouter handles /billing/checkout, /billing/subscription, /billing/webhook
 * tenantsRouter handles /tenants/me and /tenants/me/users
 * express.json() is scoped to these routers only — the webhook uses raw body above
 */
app.use(express.json({ limit: "64kb" }));
app.use(billingRouter);
app.use(tenantsRouter);

/**
 * Telemetry ingest — device auth via API key (not JWT)
 * POST /ingest is called by physical devices in the field.
 * Devices don't have browsers so they use X-Api-Key instead of OAuth Bearer.
 */
app.post(
  "/ingest",
  apiRateLimiter,
  apiKeyMiddleware,               // resolves tenantId from X-Api-Key header
  async (req: Request, res: Response) => {
    // At this point req.user is populated with { sub, tenantId, roles: ["device"] }
    // Route telemetry payload to the telemetry-service via gRPC (same path as /devices)
    const tenantId = req.user!.tenantId;
    try {
      // Forward the raw payload — telemetry-service validates the schema
      const result = await createDevice(
        tenantId,
        req.body.serialNumber,
        String(req.requestId),
        req.user!.sub,
        undefined            // no auth header — device used API key
      );
      return res.json(result);
    } catch (err) {
      console.error("[ingest]", err);
      return res.status(500).json({ error: "ingest_failed" });
    }
  }
);

/**
 * REST routes — express.json() applied only here
 */
app.post(
  "/devices",
  apiRateLimiter,
  authMiddleware,
  validate(createDeviceSchema, "body"),
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
      logAuditEvent({
        eventType: "device.created",
        actorId: userId,
        tenantId,
        resourceType: "device",
        resourceId: result?.deviceId || serialNumber,
        payload: { serialNumber, requestId },
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return res.json(result);
    } catch (err) {
      console.error(err);
      logAuditEvent({
        eventType: "device.creation_failed",
        actorId: req.user?.sub || "unknown",
        tenantId: req.user?.tenantId || "00000000-0000-0000-0000-000000000000",
        resourceType: "device",
        payload: { serialNumber: req.body?.serialNumber, error: String(err) },
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return res.status(500).json({ error: "Failed to create device" });
    }
  }
);

app.get(
  "/devices/:deviceId/latest",
  apiRateLimiter,
  authMiddleware,
  validate(deviceIdParamSchema, "params"),
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
  await writePool.end();
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
// Centralized error handler
app.use((err: Error, req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  const requestId = (req.headers["x-request-id"] as string) ?? "unknown";
  console.error({ requestId, error: err.message, stack: err.stack });
  if (res.headersSent) return next(err);
  res.status(500).json({
    error: "internal_server_error",
    message: err.message,
    requestId,
  });
});
