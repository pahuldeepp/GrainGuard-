import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { apiRateLimiter } from "../middleware/rateLimiting";
import { pool } from "../database/db";

export const adminRouter = Router();
adminRouter.use(apiRateLimiter);

function requireSuperAdmin(req: Request, res: Response): boolean {
  if (!req.user?.roles?.includes("superadmin")) {
    res.status(403).json({ error: "superadmin_required" });
    return false;
  }
  return true;
}

// GET /admin/tenants — list all tenants with counts (superadmin only)
adminRouter.get(
  "/admin/tenants",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireSuperAdmin(req, res)) return;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT
         t.id, t.name, t.slug, t.plan, t.subscription_status, t.created_at,
         (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id)::int AS device_count,
         (SELECT COUNT(*) FROM tenant_users tu WHERE tu.tenant_id = t.id)::int AS member_count
       FROM tenants t
       ORDER BY t.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return res.json(rows);
  }
);

// GET /admin/tenants/:id — single tenant detail (superadmin only)
adminRouter.get(
  "/admin/tenants/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireSuperAdmin(req, res)) return;

    const { rows } = await pool.query(
      `SELECT
         t.*,
         (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id)::int AS device_count,
         (SELECT COUNT(*) FROM tenant_users tu WHERE tu.tenant_id = t.id)::int AS member_count
       FROM tenants t
       WHERE t.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "tenant_not_found" });
    }

    return res.json(rows[0]);
  }
);
