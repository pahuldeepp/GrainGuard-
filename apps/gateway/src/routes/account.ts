import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { apiRateLimiter } from "../middleware/rateLimiting";
import { writePool as pool } from "../database/db";

export const accountRouter = Router();

accountRouter.use(apiRateLimiter);

// ── GET /account/me ─────────────────────────────────────────────────────────
// Returns the current user's profile and tenant info.
accountRouter.get(
  "/account/me",
  authMiddleware,
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;

    const { rows: userRows } = await pool.query(
      "SELECT id, email, role, created_at FROM tenant_users WHERE tenant_id = $1 AND auth_user_id = $2",
      [tenantId, userId]
    );

    const { rows: tenantRows } = await pool.query(
      `SELECT id, name, slug, plan, subscription_status, created_at
       FROM tenants WHERE id = $1`,
      [tenantId]
    );

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) AS device_count FROM devices WHERE tenant_id = $1",
      [tenantId]
    );

    return res.json({
      user: userRows[0] || null,
      tenant: tenantRows[0] || null,
      deviceCount: parseInt(countRows[0]?.device_count || "0", 10),
      roles: req.user!.roles,
    });
  }
);

// ── DELETE /account/me ──────────────────────────────────────────────────────
// GDPR Article 17 — Right to Erasure. Deletes the user's data.
// If the user is the last admin, the entire tenant is deleted.
accountRouter.delete(
  "/account/me",
  apiRateLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Check if user is the last admin
      const { rows: admins } = await client.query(
        "SELECT id FROM tenant_users WHERE tenant_id = $1 AND role = 'admin'",
        [tenantId]
      );

      const { rows: userRows } = await client.query(
        "SELECT id, role FROM tenant_users WHERE tenant_id = $1 AND auth_user_id = $2",
        [tenantId, userId]
      );

      if (userRows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "user_not_found" });
      }

      const isLastAdmin =
        userRows[0].role === "admin" &&
        admins.length === 1;

      if (isLastAdmin) {
        // Delete tenant-owned device data first because telemetry_readings
        // references devices without ON DELETE CASCADE.
        await client.query(
          `DELETE FROM telemetry_readings tr
           USING devices d
           WHERE tr.device_id = d.id
             AND d.tenant_id = $1`,
          [tenantId]
        );
        await client.query("DELETE FROM devices WHERE tenant_id = $1", [tenantId]);

        const { rows: auditEventRows } = await client.query(
          "SELECT COUNT(*)::int AS count FROM audit_events WHERE tenant_id = $1",
          [tenantId]
        );

        // Most tenant-linked tables cascade from tenants, so deleting the
        // tenant removes them automatically. Immutable audit_events are
        // intentionally retained for compliance and cannot be deleted.
        await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);

        await client.query("COMMIT");
        const immutableAuditEvents = auditEventRows[0]?.count ?? 0;
        return res.json({
          deleted: true,
          scope: "tenant",
          message:
            immutableAuditEvents > 0
              ? "Tenant deleted. Immutable audit events were retained for compliance."
              : "Tenant and all mutable data deleted",
        });
      }

      // Just remove this user from the tenant
      await client.query(
        "DELETE FROM tenant_users WHERE tenant_id = $1 AND auth_user_id = $2",
        [tenantId, userId]
      );

      await client.query("COMMIT");
      return res.json({ deleted: true, scope: "user", message: "Your account has been removed from this organisation" });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[account] delete error:", err);
      return res.status(500).json({ error: "internal_error" });
    } finally {
      client.release();
    }
  }
);

// ── GET /account/export ─────────────────────────────────────────────────────
// GDPR Article 20 — Right to Data Portability. Returns all user data as JSON.
accountRouter.get(
  "/account/export",
  apiRateLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;

      const [tenantResult, usersResult, devicesResult, alertsResult, auditResult, keysResult] =
        await Promise.all([
          pool.query("SELECT id, name, slug, plan, email, created_at FROM tenants WHERE id = $1", [tenantId]),
          pool.query("SELECT id, email, role, created_at FROM tenant_users WHERE tenant_id = $1", [tenantId]),
          pool.query("SELECT id, serial_number, created_at FROM devices WHERE tenant_id = $1", [tenantId]),
          pool.query("SELECT id, name, metric, operator, threshold, enabled, created_at FROM alert_rules WHERE tenant_id = $1", [tenantId]),
          pool.query("SELECT id, event_type, actor_id, resource_type, payload, created_at FROM audit_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1000", [tenantId]),
          pool.query("SELECT id, name, created_at, expires_at, revoked_at FROM api_keys WHERE tenant_id = $1", [tenantId]),
        ]);

      const exportData = {
        exportedAt: new Date().toISOString(),
        tenant: tenantResult.rows[0] || null,
        users: usersResult.rows,
        devices: devicesResult.rows,
        alertRules: alertsResult.rows,
        auditEvents: auditResult.rows,
        apiKeys: keysResult.rows,
      };

      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="grainguard-export-${tenantId}-${new Date().toISOString().slice(0, 10)}.json"`
      );
      return res.json(exportData);
    } catch (err) {
      console.error("[account] export error:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }
);
