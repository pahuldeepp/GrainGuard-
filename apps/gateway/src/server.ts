import express, { Request, Response } from "express";
import { createDevice } from "./services/device";
import { getDeviceLatestTelemetry } from "./services/device-query";
import { startCacheInvalidator } from "./events/cache-invalidator";
import { redis } from "./cache/redis";
import { pool } from "./db";
import { metricsHandler } from "./observability/metrics";

const app = express();
app.use(express.json());

// 🔹 Create Device (Write → gRPC)
app.post("/devices", async (req: Request, res: Response) => {
  try {
    const { tenantId, serialNumber } = req.body;

    if (!tenantId || !serialNumber) {
      return res.status(400).json({ error: "Missing tenantId or serialNumber" });
    }

    const result = await createDevice(tenantId, serialNumber);
    return res.json(result);
  } catch (err) {
    console.error("Create device error:", err);
    return res.status(500).json({ error: "Failed to create device" });
  }
});

// 🔹 Latest Telemetry (Query Layer)
app.get("/devices/:deviceId/latest", async (req: Request, res: Response) => {
  try {
    const data = await getDeviceLatestTelemetry(req.params.deviceId);

    if (!data) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json(data);
  } catch (err) {
    console.error("Read API error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// 🔹 Health
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// 🔹 Prometheus Metrics
app.get("/metrics", metricsHandler());

// 🔹 Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down gateway...");
  await redis.quit();
  await pool.end();
  process.exit(0);
});

// 🔹 Start server + Kafka invalidator AFTER boot
const PORT = 3000;

app.listen(PORT, async () => {
  console.log(`Gateway running on port ${PORT}`);

  try {
    await startCacheInvalidator();
    console.log("Cache invalidator started");
  } catch (err) {
    console.error("Failed to start cache invalidator:", err);
  }
});