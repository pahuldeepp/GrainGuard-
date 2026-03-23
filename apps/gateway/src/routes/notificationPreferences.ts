import { Router, Request, Response } from "express";
import { writePool as pool } from "../database/db";
import { authMiddleware } from "../middleware/auth";
import { apiRateLimiter } from "../middleware/rateLimiting";

export const notificationPrefsRouter = Router();
notificationPrefsRouter.use(apiRateLimiter);

// ── GET /notifications/preferences ────────────────────────────────────────
// Returns the current user's preferences (or sensible defaults).
notificationPrefsRouter.get(
  "/notifications/preferences",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT id, email_alerts, email_weekly_digest, webhook_alerts, alert_levels, updated_at
       FROM notification_preferences
       WHERE tenant_id = $1 AND user_id = $2`,
      [req.user!.tenantId, req.user!.sub]
    );

    if (rows.length === 0) {
      // Return defaults — no row yet means never customised
      return res.json({
        email_alerts:        true,
        email_weekly_digest: true,
        webhook_alerts:      false,
        alert_levels:        ["warn", "critical"],
      });
    }

    return res.json(rows[0]);
  }
);

// ── PUT /notifications/preferences ────────────────────────────────────────
// Upsert the current user's preferences.
notificationPrefsRouter.put(
  "/notifications/preferences",
  authMiddleware,
  async (req: Request, res: Response) => {
    const {
      emailAlerts,
      emailWeeklyDigest,
      webhookAlerts,
      alertLevels,
    } = req.body as {
      emailAlerts?:       boolean;
      emailWeeklyDigest?: boolean;
      webhookAlerts?:     boolean;
      alertLevels?:       string[];
    };

    const VALID_LEVELS = ["warn", "critical"];

    if (alertLevels !== undefined) {
      const invalid = alertLevels.filter((l) => !VALID_LEVELS.includes(l));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: `alertLevels must be one of: ${VALID_LEVELS.join(", ")}`,
        });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO notification_preferences
         (tenant_id, user_id, email_alerts, email_weekly_digest, webhook_alerts, alert_levels)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET
         email_alerts        = COALESCE($3, notification_preferences.email_alerts),
         email_weekly_digest = COALESCE($4, notification_preferences.email_weekly_digest),
         webhook_alerts      = COALESCE($5, notification_preferences.webhook_alerts),
         alert_levels        = COALESCE($6, notification_preferences.alert_levels),
         updated_at          = NOW()
       RETURNING id, email_alerts, email_weekly_digest, webhook_alerts, alert_levels, updated_at`,
      [
        req.user!.tenantId,
        req.user!.sub,
        emailAlerts       ?? true,
        emailWeeklyDigest ?? true,
        webhookAlerts     ?? false,
        alertLevels       ?? ["warn", "critical"],
      ]
    );

    return res.json(rows[0]);
  }
);
