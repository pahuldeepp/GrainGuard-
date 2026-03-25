import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { writePool as pool } from "../lib/db";
import { authMiddleware } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";

export const alertRulesRouter = Router();

// ── GET /alert-rules ──────────────────────────────────────────────────────
alertRulesRouter.get(
  "/alert-rules",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT id, name, metric, operator, threshold, level, enabled, created_at, updated_at
       FROM alert_rules
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [req.user!.tenantId]
    );
    return res.json(rows);
  }
);

// ── POST /alert-rules ─────────────────────────────────────────────────────
alertRulesRouter.post(
  "/alert-rules",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { name, metric, operator, threshold, level, enabled } = req.body as {
      name: string;
      metric: string;
      operator: string;
      threshold: number;
      level?: string;
      enabled?: boolean;
    };

    if (!name?.trim() || !metric?.trim() || !operator?.trim() || threshold == null) {
      return res.status(400).json({ error: "name, metric, operator, threshold are required" });
    }

    const VALID_METRICS   = ["temperature", "humidity", "co2", "battery"];
    const VALID_OPERATORS = [">=", ">", "<=", "<", "=="];
    const VALID_LEVELS    = ["warn", "critical"];

    if (!VALID_METRICS.includes(metric)) {
      return res.status(400).json({ error: `metric must be one of: ${VALID_METRICS.join(", ")}` });
    }
    if (!VALID_OPERATORS.includes(operator)) {
      return res.status(400).json({ error: `operator must be one of: ${VALID_OPERATORS.join(", ")}` });
    }
    if (level && !VALID_LEVELS.includes(level)) {
      return res.status(400).json({ error: `level must be one of: ${VALID_LEVELS.join(", ")}` });
    }

    const id = uuidv4();
    const { rows } = await pool.query(
      `INSERT INTO alert_rules (id, tenant_id, name, metric, operator, threshold, level, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING id, name, metric, operator, threshold, level, enabled, created_at, updated_at`,
      [
        id,
        req.user!.tenantId,
        name.trim(),
        metric,
        operator,
        threshold,
        level ?? "warn",
        enabled ?? true,
      ]
    );

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "alert_rule.created",
      resourceId:   id,
      resourceType: "alert_rule",
      meta:         { name, metric, operator, threshold, level },
      ipAddress:    req.ip,
    });

    return res.status(201).json(rows[0]);
  }
);

// ── PUT /alert-rules/:id ──────────────────────────────────────────────────
alertRulesRouter.put(
  "/alert-rules/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, metric, operator, threshold, level, enabled } = req.body;

    const { rows } = await pool.query(
      `UPDATE alert_rules
       SET
         name      = COALESCE($1, name),
         metric    = COALESCE($2, metric),
         operator  = COALESCE($3, operator),
         threshold = COALESCE($4, threshold),
         level     = COALESCE($5, level),
         enabled   = COALESCE($6, enabled),
         updated_at = NOW()
       WHERE id = $7 AND tenant_id = $8
       RETURNING id, name, metric, operator, threshold, level, enabled, created_at, updated_at`,
      [
        name ?? null,
        metric ?? null,
        operator ?? null,
        threshold ?? null,
        level ?? null,
        enabled ?? null,
        id,
        req.user!.tenantId,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "alert_rule_not_found" });
    }

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "alert_rule.updated",
      resourceId:   id,
      resourceType: "alert_rule",
      meta:         { name, metric, operator, threshold, level, enabled },
      ipAddress:    req.ip,
    });

    return res.json(rows[0]);
  }
);

// ── DELETE /alert-rules/:id ───────────────────────────────────────────────
alertRulesRouter.delete(
  "/alert-rules/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    // Fetch rule first so we can log its details
    const { rows: existing } = await pool.query(
      "SELECT name, metric FROM alert_rules WHERE id = $1 AND tenant_id = $2",
      [id, req.user!.tenantId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "alert_rule_not_found" });
    }

    await pool.query(
      "DELETE FROM alert_rules WHERE id = $1 AND tenant_id = $2",
      [id, req.user!.tenantId]
    );

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "alert_rule.deleted",
      resourceId:   id,
      resourceType: "alert_rule",
      meta:         { name: existing[0].name, metric: existing[0].metric },
      ipAddress:    req.ip,
    });

    return res.json({ deleted: true });
  }
);