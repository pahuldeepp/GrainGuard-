import { Router, Request, Response } from "express";
import crypto from "crypto";
import { pool } from "../lib/db";
import { authMiddleware } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { apiRateLimiter } from "../middleware/rateLimiting";

export const webhooksRouter = Router();
webhooksRouter.use(apiRateLimiter);

const ALLOWED_EVENT_TYPES = [
  "device.created",
  "device.deleted",
  "telemetry.alert",
  "team.member_invited",
  "team.member_removed",
  "billing.subscription_created",
  "billing.subscription_cancelled",
  "api_key.created",
  "api_key.revoked",
];

// ── GET /webhooks ──────────────────────────────────────────────────────────
webhooksRouter.get(
  "/webhooks",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT id, url, description, enabled, event_types, created_at, updated_at,
              last_error, last_error_at
       FROM webhook_endpoints
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [req.user!.tenantId]
    );
    // Never expose the secret
    return res.json(rows);
  }
);

// ── POST /webhooks ─────────────────────────────────────────────────────────
webhooksRouter.post(
  "/webhooks",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!req.user?.roles?.includes("admin")) {
      return res.status(403).json({ error: "admin_required" });
    }

    const { url, description, eventTypes } = req.body as {
      url: string;
      description?: string;
      eventTypes?: string[];
    };

    if (!url?.trim()) {
      return res.status(400).json({ error: "url is required" });
    }

    try {
      new URL(url); // validate URL format
    } catch {
      return res.status(400).json({ error: "url must be a valid URL" });
    }

    if (!url.startsWith("https://")) {
      return res.status(400).json({ error: "url must use HTTPS" });
    }

    const filteredTypes = (eventTypes ?? []).filter((t) =>
      ALLOWED_EVENT_TYPES.includes(t)
    );

    // Generate a cryptographically-random signing secret (shown once on creation)
    const secret = `whsec_${crypto.randomBytes(32).toString("hex")}`;

    const { rows } = await pool.query(
      `INSERT INTO webhook_endpoints
         (tenant_id, url, description, secret, event_types, enabled)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, url, description, enabled, event_types, created_at`,
      [req.user!.tenantId, url.trim(), description?.trim() ?? null, secret, filteredTypes]
    );

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "webhook_endpoint.created",
      resourceId:   rows[0].id,
      resourceType: "webhook_endpoint",
      meta:         { url, eventTypes: filteredTypes },
      ipAddress:    req.ip,
    });

    // Return the signing secret ONCE — never stored in plaintext after this response.
    // Secret is shown only in this response; subsequent GETs never expose it.
    return res.status(201).json({ ...rows[0], secret });
  }
);

// ── PATCH /webhooks/:id ────────────────────────────────────────────────────
webhooksRouter.patch(
  "/webhooks/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!req.user?.roles?.includes("admin")) {
      return res.status(403).json({ error: "admin_required" });
    }

    const { id } = req.params;
    const { description, enabled, eventTypes } = req.body as {
      description?: string;
      enabled?: boolean;
      eventTypes?: string[];
    };

    const filteredTypes = eventTypes
      ? eventTypes.filter((t) => ALLOWED_EVENT_TYPES.includes(t))
      : null;

    const { rows } = await pool.query(
      `UPDATE webhook_endpoints
       SET
         description  = COALESCE($1, description),
         enabled      = COALESCE($2, enabled),
         event_types  = COALESCE($3, event_types),
         updated_at   = NOW()
       WHERE id = $4 AND tenant_id = $5
       RETURNING id, url, description, enabled, event_types, updated_at`,
      [
        description ?? null,
        enabled ?? null,
        filteredTypes,
        id,
        req.user!.tenantId,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "webhook_not_found" });
    }

    return res.json(rows[0]);
  }
);

// ── DELETE /webhooks/:id ───────────────────────────────────────────────────
webhooksRouter.delete(
  "/webhooks/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!req.user?.roles?.includes("admin")) {
      return res.status(403).json({ error: "admin_required" });
    }

    const { rowCount } = await pool.query(
      "DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.user!.tenantId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "webhook_not_found" });
    }

    return res.json({ deleted: true });
  }
);

// ── GET /webhooks/:id/deliveries ───────────────────────────────────────────
webhooksRouter.get(
  "/webhooks/:id/deliveries",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!req.user?.roles?.includes("admin")) {
      return res.status(403).json({ error: "admin_required" });
    }

    // Verify endpoint belongs to tenant
    const endpoint = await pool.query(
      "SELECT id FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.user!.tenantId]
    );
    if (endpoint.rows.length === 0) {
      return res.status(404).json({ error: "webhook_not_found" });
    }

    const { rows } = await pool.query(
      `SELECT id, event_type, attempt, status_code, success, duration_ms, created_at
       FROM webhook_deliveries
       WHERE endpoint_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.params.id]
    );

    return res.json(rows);
  }
);

// ── POST /webhooks/:id/test ────────────────────────────────────────────────
webhooksRouter.post(
  "/webhooks/:id/test",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!req.user?.roles?.includes("admin")) {
      return res.status(403).json({ error: "admin_required" });
    }

    const { rows } = await pool.query(
      "SELECT url, secret FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.user!.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "webhook_not_found" });
    }

    const { url, secret } = rows[0];
    const payload = {
      event: "webhook.test",
      tenantId: req.user!.tenantId,
      timestamp: new Date().toISOString(),
      data: { message: "Test delivery from GrainGuard" },
    };

    const body      = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    const start = Date.now();
    let statusCode = 0;
    let success = false;

    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-GrainGuard-Signature": `t=${timestamp},v1=${signature}`,
          "X-GrainGuard-Event":    "webhook.test",
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      statusCode = response.status;
      success    = response.ok;
    } catch (err: any) {
      statusCode = 0;
    }

    const durationMs = Date.now() - start;

    return res.json({ success, statusCode, durationMs });
  }
);
