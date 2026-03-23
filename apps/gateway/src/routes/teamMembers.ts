import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../lib/db";
import { authMiddleware } from "../lib/auth";
import { setUserTenantId, assignRoleByName, inviteToOrg } from "../lib/auth0-mgmt";
import { writeAuditLog } from "../lib/audit";

export const teamRouter = Router();

function requireAdmin(req: Request, res: Response): boolean {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

// ── GET /team/members ─────────────────────────────────────────────────────
teamRouter.get(
  "/team/members",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT id, auth_user_id, email, role, created_at
       FROM tenant_users
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [req.user!.tenantId]
    );
    return res.json(rows);
  }
);

// ── POST /team/invite ─────────────────────────────────────────────────────
teamRouter.post(
  "/team/invite",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { email, role } = req.body as { email: string; role?: string };
    if (!email?.trim()) {
      return res.status(400).json({ error: "email is required" });
    }

    const memberRole = role === "admin" ? "admin" : "member";
    const token      = uuidv4();
    const tenantId   = req.user!.tenantId;
    const inviteId   = uuidv4();

    // Check if already a member
    const existing = await pool.query(
      "SELECT id FROM tenant_users WHERE tenant_id = $1 AND email = $2",
      [tenantId, email.trim().toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "user_already_member" });
    }

    // Check if invite already pending
    const pendingInvite = await pool.query(
      `SELECT id FROM tenant_invites
       WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL AND expires_at > NOW()`,
      [tenantId, email.trim().toLowerCase()]
    );
    if (pendingInvite.rows.length > 0) {
      return res.status(409).json({ error: "invite_already_pending" });
    }

    await pool.query(
      `INSERT INTO tenant_invites (id, tenant_id, email, role, invited_by, token, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days', NOW())`,
      [inviteId, tenantId, email.trim().toLowerCase(), memberRole, req.user!.sub, token]
    );

    // Send Auth0 org invite so the user gets an email and lands in the org
    inviteToOrg(email.trim().toLowerCase(), memberRole, tenantId).catch((e) =>
      console.error("[team] inviteToOrg failed (non-fatal):", e)
    );

    await writeAuditLog({
      tenantId,
      actorId:      req.user!.sub,
      eventType:    "team.member_invited",
      resourceId:   inviteId,
      resourceType: "invite",
      meta:         { email: email.trim().toLowerCase(), role: memberRole },
      ipAddress:    req.ip,
    });

    return res.status(201).json({
      invited:     true,
      email:       email.trim().toLowerCase(),
      role:        memberRole,
      inviteToken: token,
    });
  }
);

// ── GET /team/invite/info — PUBLIC — returns invite metadata by token ─────
// Used by the invite acceptance page to show tenant name BEFORE the user
// logs in.  Does NOT expose sensitive data (no emails, no auth_user_ids).
teamRouter.get(
  "/team/invite/info",
  async (req: Request, res: Response) => {
    const { token } = req.query as { token?: string };
    if (!token) return res.status(400).json({ error: "token is required" });

    const { rows } = await pool.query(
      `SELECT ti.id, t.name AS tenant_name, ti.role, ti.expires_at, ti.accepted_at
       FROM tenant_invites ti
       JOIN tenants t ON t.id = ti.tenant_id
       WHERE ti.token = $1`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "invite_not_found" });
    }

    const invite = rows[0];

    if (invite.accepted_at) {
      return res.status(410).json({ error: "invite_expired", reason: "already_accepted" });
    }
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: "invite_expired", reason: "expired" });
    }

    return res.json({
      tenantName: invite.tenant_name,
      role:       invite.role,
    });
  }
);

// ── GET /team/invites ─────────────────────────────────────────────────────
teamRouter.get(
  "/team/invites",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { rows } = await pool.query(
      `SELECT id, email, role, invited_by, token, accepted_at, expires_at, created_at
       FROM tenant_invites
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [req.user!.tenantId]
    );
    return res.json(rows);
  }
);

// ── POST /team/invite/accept ──────────────────────────────────────────────
teamRouter.post(
  "/team/invite/accept",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { token } = req.body as { token: string };
    if (!token) return res.status(400).json({ error: "token is required" });

    const { rows } = await pool.query(
      `SELECT id, tenant_id, email, role FROM tenant_invites
       WHERE token = $1 AND accepted_at IS NULL AND expires_at > NOW()`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "invite_not_found_or_expired" });
    }

    const invite = rows[0];

    try {
      await pool.query("BEGIN");

      await pool.query(
        `INSERT INTO tenant_users (id, tenant_id, auth_user_id, email, role, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [uuidv4(), invite.tenant_id, req.user!.sub, invite.email, invite.role]
      );

      await pool.query(
        "UPDATE tenant_invites SET accepted_at = NOW() WHERE id = $1",
        [invite.id]
      );

      await pool.query("COMMIT");

      setUserTenantId(req.user!.sub, invite.tenant_id).catch((e) =>
        console.error("[team] failed to set Auth0 tenant_id:", e)
      );
      assignRoleByName(req.user!.sub, invite.role).catch((e) =>
        console.error("[team] failed to assign role:", e)
      );

      await writeAuditLog({
        tenantId:     invite.tenant_id,
        actorId:      req.user!.sub,
        eventType:    "team.invite_accepted",
        resourceId:   invite.id,
        resourceType: "invite",
        meta:         { email: invite.email, role: invite.role },
        ipAddress:    req.ip,
      });

      return res.json({ accepted: true, tenantId: invite.tenant_id, role: invite.role });
    } catch (err: any) {
      await pool.query("ROLLBACK");
      if (err.code === "23505") {
        return res.status(409).json({ error: "already_a_member" });
      }
      console.error("[team] accept error:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }
);

// ── PUT /team/members/:id/role ────────────────────────────────────────────
teamRouter.put(
  "/team/members/:id/role",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;
    const { role } = req.body as { role: string };

    if (!["admin", "member"].includes(role)) {
      return res.status(400).json({ error: "role must be 'admin' or 'member'" });
    }

    const { rows } = await pool.query(
      `UPDATE tenant_users SET role = $1
       WHERE id = $2 AND tenant_id = $3
       RETURNING id, auth_user_id, email, role`,
      [role, id, req.user!.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "member_not_found" });
    }

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "team.member_role_changed",
      resourceId:   id,
      resourceType: "tenant_user",
      meta:         { newRole: role, targetEmail: rows[0].email },
      ipAddress:    req.ip,
    });

    return res.json(rows[0]);
  }
);

// ── DELETE /team/members/:id ──────────────────────────────────────────────
teamRouter.delete(
  "/team/members/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    const { rows: memberRows } = await pool.query(
      "SELECT auth_user_id, email FROM tenant_users WHERE id = $1 AND tenant_id = $2",
      [id, req.user!.tenantId]
    );
    if (memberRows.length === 0) {
      return res.status(404).json({ error: "member_not_found" });
    }
    if (memberRows[0].auth_user_id === req.user!.sub) {
      return res.status(400).json({ error: "cannot_remove_self" });
    }

    await pool.query(
      "DELETE FROM tenant_users WHERE id = $1 AND tenant_id = $2",
      [id, req.user!.tenantId]
    );

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "team.member_removed",
      resourceId:   id,
      resourceType: "tenant_user",
      meta:         { removedEmail: memberRows[0].email },
      ipAddress:    req.ip,
    });

    return res.json({ deleted: true });
  }
);

// ── DELETE /team/invites/:id ──────────────────────────────────────────────
teamRouter.delete(
  "/team/invites/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { rows: inviteRows } = await pool.query(
      "SELECT email FROM tenant_invites WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.user!.tenantId]
    );

    const { rowCount } = await pool.query(
      "DELETE FROM tenant_invites WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.user!.tenantId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "invite_not_found" });
    }

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "team.invite_revoked",
      resourceId:   req.params.id,
      resourceType: "invite",
      meta:         { email: inviteRows[0]?.email },
      ipAddress:    req.ip,
    });

    return res.json({ deleted: true });
  }
);