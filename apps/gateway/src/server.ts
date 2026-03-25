import "./tracing";
import express, { Request, Response, NextFunction } from "express";
import http from "http";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createDevice } from "./services/device";
import { getDeviceLatestTelemetry } from "./services/device-query";
import { redis } from "./cache/redis";
import { pool } from "./database/db";
import { writeAuditLog as logAuditEvent } from "./lib/audit";

import { metricsHandler, requestLatency } from "./observability/metrics";
import { requestIdMiddleware } from "./middleware/requestId";
import { authMiddleware } from "./middleware/auth";
// apiKeyMiddleware removed — device ingest moved to Go ingest-service
import { apiRateLimiter } from "./middleware/rateLimiting";
import { validate, createDeviceSchema, deviceIdParamSchema } from "./middleware/validation";
import { apiVersionMiddleware } from "./middleware/apiVersion";
import { securityHeaders, permissionsPolicy } from "./middleware/securityHeaders";
import { csrfProtection } from "./middleware/csrf";
import { billingRouter } from "./routes/billing";
import { tenantsRouter } from "./routes/tenants";
import { ssoRouter } from "./routes/sso";
import { devicesImportRouter } from "./routes/devicesImport";
import { alertRulesRouter } from "./routes/alertRules";
import { auditLogRouter } from "./routes/auditLog";
import { teamRouter } from "./routes/teamMembers";
import { apiKeysRouter } from "./routes/apiKeys";
import { devicesRouter } from "./routes/devices";
import { accountRouter } from "./routes/account";
import { webhooksRouter } from "./routes/webhooks";
import { notificationPrefsRouter } from "./routes/notificationPreferences";
import { adminRouter } from "./routes/admin";

// ── Startup environment validation ────────────────────────────────────────
(function validateEnv() {
  if (
    !process.env.STRIPE_SECRET_KEY ||
    process.env.STRIPE_SECRET_KEY === "sk_test_placeholder"
  ) {
    console.warn(
      "[startup] ⚠  STRIPE_SECRET_KEY is missing or placeholder — " +
      "billing routes will not work. Set STRIPE_SECRET_KEY in your .env."
    );
  }

  if (
    !process.env.AUTH0_MANAGEMENT_CLIENT_ID ||
    process.env.AUTH0_MANAGEMENT_CLIENT_ID === ""
  ) {
    console.warn(
      "[startup] ⚠  AUTH0_MANAGEMENT_CLIENT_ID not set — " +
      "SSO configuration and team invite emails via Auth0 will fail."
    );
  }

  if (
    !process.env.AUTH0_MANAGEMENT_CLIENT_SECRET ||
    process.env.AUTH0_MANAGEMENT_CLIENT_SECRET === ""
  ) {
    console.warn(
      "[startup] ⚠  AUTH0_MANAGEMENT_CLIENT_SECRET not set — " +
      "SSO configuration and team invite emails via Auth0 will fail."
    );
  }

  if (!process.env.JWKS_URL) {
    if (process.env.NODE_ENV === "production") {
      console.error("[startup] ✗  JWKS_URL is required in production. Exiting.");
      process.exit(1);
    } else {
      console.warn("[startup] ⚠  JWKS_URL not set — JWT verification will fail unless AUTH_ENABLED=false.");
    }
  }
})();

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
app.use(cookieParser()); // required for req.cookies used by csrfProtection()

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

// Public routes — rate-limited by IP (no JWT required)
app.use(tenantsRouter);

// Authenticated routers — each router applies its own rate limiter internally
// so that billing/bulk/api limiters don't bleed across route boundaries.
app.use(billingRouter);
app.use(devicesImportRouter);
app.use(alertRulesRouter);
app.use(auditLogRouter);
app.use(ssoRouter);
app.use(teamRouter);
app.use(apiKeysRouter);
app.use(devicesRouter);
app.use(accountRouter);
app.use(webhooksRouter);
app.use(notificationPrefsRouter);
app.use(adminRouter);

/**
 * Telemetry ingest — DEPRECATED on Gateway.
 * Devices should POST to the dedicated Go ingest-service (:3001/ingest) directly.
 * This stub returns a 308 redirect hint for any device still pointing here.
 */
app.post("/ingest", (_req: Request, res: Response) => {
  res.status(308).json({
    error: "moved_permanently",
    message: "Device ingest has moved to the dedicated ingest service on port 3001",
    location: "/ingest on ingest-service:3001",
  });
});

app.post(
  "/devices",
  authMiddleware,    // auth first → req.user.tenantId is set for the rate limiter
  apiRateLimiter,
  validate(createDeviceSchema, "body"),
  async (req: Request, res: Response) => {
    try {
      const { serialNumber } = req.body;
      if (!serialNumber)
        return res.status(400).json({ error: "Missing serialNumber" });

      const tenantId = req.user!.tenantId;
      const userId = req.user!.sub;
      const requestId = String(req.requestId);

      // ── Plan enforcement: check device quota ──────────────────────────
      const { checkDeviceQuota } = await import("./services/planEnforcement");
      const quotaCheck = await checkDeviceQuota(tenantId);
      if (!quotaCheck.allowed) {
        return res.status(403).json({
          error: "device_limit_reached",
          message: quotaCheck.message,
          currentCount: quotaCheck.currentCount,
          maxDevices: quotaCheck.maxDevices,
          plan: quotaCheck.plan,
        });
      }

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
        meta: { serialNumber, requestId },
        ipAddress: req.ip,
      });
      return res.json(result);
    } catch (err) {
      console.error(err);
      logAuditEvent({
        eventType: "device.creation_failed",
        actorId: req.user?.sub || "unknown",
        tenantId: req.user?.tenantId || "00000000-0000-0000-0000-000000000000",
        resourceType: "device",
        meta: { serialNumber: req.body?.serialNumber, error: String(err) },
        ipAddress: req.ip,
      });
      return res.status(500).json({ error: "Failed to create device" });
    }
  }
);

app.get(
  "/devices/:deviceId/latest",
  authMiddleware,    // auth first → tenant-scoped rate limit
  apiRateLimiter,
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

// Liveness probe — always 200 if the process is running
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Readiness probe — checks DB + Redis connectivity
app.get("/health/ready", async (_req, res) => {
  const checks: Record<string, string> = {};
  try {
    await pool.query("SELECT 1");
    checks.postgres = "ok";
  } catch {
    checks.postgres = "error";
  }
  try {
    await redis.ping();
    checks.redis = "ok";
  } catch {
    checks.redis = "error";
  }
  const allOk = Object.values(checks).every((v) => v === "ok");
  return res.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "degraded", checks });
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
