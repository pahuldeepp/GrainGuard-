import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../database/db";

export const alertRulesRouter = Router();

// Alert rules define when workflow-alerts should fire for a device.
// Each rule is: if metric > threshold for device_type (or *), send alert.
// Stored in Postgres so they are tenant-isolated and durable.
//
// Table: alert_rules
//   id          UUID PK
//   tenant_id   UUID FK → tenants
//   name        TEXT   (human label, e.g. "High temperature")
//   metric      TEXT   (e.g. "temperature", "humidity", "co2")
//   operator    TEXT   (">", "<", ">=", "<=", "==")
//   threshold   FLOAT
//   device_type TEXT   (NULL = applies to all device types)
//   enabled     BOOL   DEFAULT true
//   created_at  TIMESTAMPTZ
//   updated_at  TIMESTAMPTZ

// ── GET /alert-rules ──────────────────────────────────────────────────────────
alertRulesRouter.get(
  "/alert-rules",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT id, name, metric, operator, threshold, device_type, enabled, created_at
       FROM alert_rules
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [req.user!.tenantId]
    );
    return res.json(rows);
  }
);

// ── POST /alert-rules ─────────────────────────────────────────────────────────
alertRulesRouter.post(
  "/alert-rules",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { name, metric, operator, threshold, device_type } = req.body as {
      name:        string;
      metric:      string;
      operator:    string;
      threshold:   number;
      device_type: string | null;
    };

    const ALLOWED_OPERATORS = [">", "<", ">=", "<=", "=="];
    const ALLOWED_METRICS   = ["temperature", "humidity", "co2", "pressure", "battery"];

    if (!name || !metric || !operator || threshold == null) {
      return res.status(400).json({ error: "missing_fields" });
    }
    if (!ALLOWED_OPERATORS.includes(operator)) {
      return res.status(400).json({ error: "invalid_operator", allowed: ALLOWED_OPERATORS });
    }
    if (!ALLOWED_METRICS.includes(metric)) {
      return res.status(400).json({ error: "invalid_metric", allowed: ALLOWED_METRICS });
    }

    const { rows } = await pool.query(
      `INSERT INTO alert_rules (tenant_id, name, metric, operator, threshold, device_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, metric, operator, threshold, device_type, enabled, created_at`,
      [req.user!.tenantId, name, metric, operator, threshold, device_type ?? null]
    );

    return res.status(201).json(rows[0]);
  }
);

// ── PUT /alert-rules/:id ──────────────────────────────────────────────────────
alertRulesRouter.put(
  "/alert-rules/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, metric, operator, threshold, device_type, enabled } = req.body as {
      name?:        string;
      metric?:      string;
      operator?:    string;
      threshold?:   number;
      device_type?: string | null;
      enabled?:     boolean;
    };

    // Only update the tenant's own rule — prevents cross-tenant tampering
    const { rows } = await pool.query(
      `UPDATE alert_rules
         SET name        = COALESCE($1, name),
             metric      = COALESCE($2, metric),
             operator    = COALESCE($3, operator),
             threshold   = COALESCE($4, threshold),
             device_type = COALESCE($5, device_type),
             enabled     = COALESCE($6, enabled),
             updated_at  = NOW()
       WHERE id = $7 AND tenant_id = $8
       RETURNING *`,
      [name, metric, operator, threshold, device_type, enabled, id, req.user!.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "rule_not_found" });
    }

    return res.json(rows[0]);
  }
);

// ── DELETE /alert-rules/:id ───────────────────────────────────────────────────
alertRulesRouter.delete(
  "/alert-rules/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const { rowCount } = await pool.query(
      "DELETE FROM alert_rules WHERE id = $1 AND tenant_id = $2",
      [id, req.user!.tenantId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "rule_not_found" });
    }

    return res.json({ deleted: true });
  }
);
