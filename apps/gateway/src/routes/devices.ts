import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { apiRateLimiter } from "../middleware/rateLimiting";
import { writePool as pool } from "../database/db";

export const devicesRouter = Router();

devicesRouter.use(apiRateLimiter);

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
