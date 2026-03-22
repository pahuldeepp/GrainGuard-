import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../database/db";

export const tenantsRouter = Router();

// ── GET /tenants/me ────────────────────────────────────────────────────────────
// Returns the current tenant's profile — name, plan, trial status, user count.
// The dashboard calls this on load to populate the settings page.
tenantsRouter.get(
  "/tenants/me",
  authMiddleware,                           // must carry a valid JWT
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;    // extracted from JWT by authMiddleware

    const row = await pool.query(
      `SELECT id, name, email, plan, subscription_status,
              trial_ends_at, current_period_end, created_at
       FROM tenants WHERE id = $1`,
      [tenantId]
    );

    if (row.rows.length === 0) {
      return res.status(404).json({ error: "tenant_not_found" });
    }

    return res.json(row.rows[0]);
  }
);

// ── GET /tenants/me/users ──────────────────────────────────────────────────────
// Lists all users that belong to this tenant, with their roles.
// Used by the admin panel to show who has access to the account.
tenantsRouter.get(
  "/tenants/me/users",
  authMiddleware,
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    // Only admins should see the full user list
    if (!req.user!.roles?.includes("admin")) {
      return res.status(403).json({ error: "forbidden" });
    }

    const rows = await pool.query(
      `SELECT u.id, u.email, tu.role, tu.created_at AS joined_at
       FROM tenant_users tu
       JOIN users u ON u.id = tu.user_id
       WHERE tu.tenant_id = $1
       ORDER BY tu.created_at ASC`,
      [tenantId]
    );

    return res.json(rows.rows);
  }
);

// ── POST /tenants/me/users ─────────────────────────────────────────────────────
// Invites a new user to the tenant (or re-grants access if already registered).
// Admin only — the invited email will receive an Auth0 invitation email.
tenantsRouter.post(
  "/tenants/me/users",
  authMiddleware,
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    if (!req.user!.roles?.includes("admin")) {
      return res.status(403).json({ error: "forbidden" });
    }

    const { email, role = "member" } = req.body as { email: string; role?: string };

    if (!email) {
      return res.status(400).json({ error: "email_required" });
    }

    // Allowed roles — prevents privilege escalation via API
    const ALLOWED_ROLES = ["member", "viewer", "admin"];
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: "invalid_role" });
    }

    // Upsert: if user already exists in this tenant update their role;
    // otherwise insert a pending invite row (user_id will be filled on first login)
    await pool.query(
      `INSERT INTO tenant_invites (tenant_id, email, role, invited_by, invited_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tenant_id, email) DO UPDATE
         SET role = EXCLUDED.role,
             invited_by = EXCLUDED.invited_by,
             invited_at = NOW()`,
      [tenantId, email.toLowerCase(), role, req.user!.sub]
    );

    return res.status(201).json({ invited: true, email, role });
  }
);

// ── DELETE /tenants/me/users/:userId ──────────────────────────────────────────
// Removes a user from the tenant. Admin can't remove themselves.
tenantsRouter.delete(
  "/tenants/me/users/:userId",
  authMiddleware,
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { userId } = req.params;

    if (!req.user!.roles?.includes("admin")) {
      return res.status(403).json({ error: "forbidden" });
    }

    // Prevent self-removal — an org with no admin is unrecoverable
    if (req.user!.sub === userId) {
      return res.status(400).json({ error: "cannot_remove_self" });
    }

    await pool.query(
      "DELETE FROM tenant_users WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId]
    );

    return res.json({ removed: true });
  }
);
