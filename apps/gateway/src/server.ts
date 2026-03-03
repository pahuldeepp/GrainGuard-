import "./tracing";
import express, { Request, Response } from "express";
import { createDevice } from "./services/device";
import { getDeviceLatestTelemetry } from "./services/device-query";
import { redis } from "./cache/redis";
import { pool } from "./database/db";
import { metricsHandler, requestLatency } from "./observability/metrics";
import { requestIdMiddleware } from "./middleware/requestId";
import { authMiddleware } from "./middleware/auth";

const app = express();

/* -----------------------------
   Body Parser
------------------------------*/
app.use(express.json());

/* -----------------------------
   Request ID
------------------------------*/
app.use(requestIdMiddleware);

/* -----------------------------
   Request Latency
------------------------------*/
app.use((req, res, next) => {
  const end = requestLatency.startTimer();
  res.on("finish", () => end());
  next();
});

/* -----------------------------
   Structured Logging
------------------------------*/
app.use((req, _res, next) => {
  console.log(
    `[gateway] request_id=${req.requestId} ${req.method} ${req.path}`
  );
  next();
});

/* =========================================================
   🔐 PROTECTED ROUTES (JWT REQUIRED)
========================================================= */

/* -----------------------------
   Create Device (Write → gRPC)
------------------------------*/
app.post("/devices", authMiddleware, async (req: Request, res: Response) => {
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
    console.error(`[gateway] request_id=${req.requestId} Create device error:`, err);
    return res.status(500).json({ error: "Failed to create device" });
  }
});

/* -----------------------------
   Latest Telemetry (Read side)
------------------------------*/
app.get(
  "/devices/:deviceId/latest",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const data = await getDeviceLatestTelemetry(req.params["deviceId"] as string);

      if (!data) {
        return res.status(404).json({ error: "Not found" });
      }

      return res.json(data);
    } catch (err) {
      console.error(
        `[gateway] request_id=${req.requestId} Read API error:`,
        err
      );
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

/* =========================================================
   PUBLIC ROUTES
========================================================= */

/* -----------------------------
   Health
------------------------------*/
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/* -----------------------------
   Metrics
------------------------------*/
app.get("/metrics", metricsHandler());

/* -----------------------------
   Graceful Shutdown
------------------------------*/
process.on("SIGTERM", async () => {
  console.log("Shutting down gateway...");
  await redis.quit();
  await pool.end();
  process.exit(0);
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Gateway running on port ${PORT}`);
});