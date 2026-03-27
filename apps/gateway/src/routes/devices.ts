import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { apiRateLimiter } from "../middleware/rateLimiting";
import { deviceQuotaMiddleware } from "../middleware/quota";
import { writePool as pool } from "../database/db";
import { checkDeviceQuota } from "../services/planEnforcement";

export const devicesRouter = Router();

devicesRouter.use(apiRateLimiter);

// ── GET /devices/quota ───────────────────────────────────────────────────────
devicesRouter.get(
  "/devices/quota",
  authMiddleware,
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const [quota, usage] = await Promise.all([
      checkDeviceQuota(tenantId),
      pool.query(
        `SELECT COALESCE(event_count, 0) AS events_today
         FROM tenant_usage
         WHERE tenant_id = $1 AND day = CURRENT_DATE`,
        [tenantId]
      ),
    ]);
    return res.json({
      plan:         quota.plan,
      deviceCount:  quota.currentCount,
      deviceLimit:  quota.maxDevices,
      eventsToday:  parseInt(usage.rows[0]?.events_today ?? "0", 10),
    });
  }
);

// ── DELETE /devices/:id ─────────────────────────────────────────────────────
devicesRouter.delete(
  "/devices/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;

    const { rowCount } = await pool.query(
      "DELETE FROM devices WHERE id = $1 AND tenant_id = $2",
      [id, tenantId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "device_not_found" });
    }

    return res.json({ deleted: true });
  }
);

// ── POST /devices ────────────────────────────────────────────────────────────
// Single device registration — quota-gated
devicesRouter.post(
  "/devices",
  authMiddleware,
  deviceQuotaMiddleware,
  async (req: Request, res: Response) => {
    const { serialNumber } = req.body as { serialNumber?: string };
    if (!serialNumber || !/^[A-Za-z0-9_-]{3,64}$/.test(serialNumber)) {
      return res.status(400).json({ error: "invalid_serial_number" });
    }

    const tenantId = req.user!.tenantId;
    const { createDevice } = await import("../services/device");
    const device = await createDevice(tenantId, serialNumber, undefined, req.user!.sub, undefined);
    return res.status(201).json(device);
  }
);
