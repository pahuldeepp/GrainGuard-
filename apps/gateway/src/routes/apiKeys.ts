import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { apiRateLimiter } from "../middleware/rateLimiting";
import { writePool as pool } from "../database/db";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

export const apiKeysRouter = Router();

apiKeysRouter.use(apiRateLimiter);

function requireAdmin(req: Request, res: Response): boolean {
  if (!req.user!.roles?.includes("admin")) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

// ── GET /api-keys ───────────────────────────────────────────────────────────
apiKeysRouter.get(
  "/api-keys",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { rows } = await pool.query(
      `SELECT id, name, created_at, expires_at, revoked_at, last_used_at
       FROM api_keys
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [req.user!.tenantId]
    );

    return res.json(rows);
  }
);

// ── POST /api-keys ──────────────────────────────────────────────────────────
apiKeysRouter.post(
  "/api-keys",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { name, expiresInDays } = req.body as {
      name: string;
      expiresInDays?: number;
    };

    if (!name?.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const rawKey = `gg_${crypto.randomBytes(32).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const { rows } = await pool.query(
      `INSERT INTO api_keys (id, tenant_id, name, key_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, name, created_at, expires_at`,
      [uuidv4(), req.user!.tenantId, name.trim(), keyHash, expiresAt]
    );

    return res.status(201).json({
      ...rows[0],
      key: rawKey,
    });
  }
);

// ── DELETE /api-keys/:id (revoke) ───────────────────────────────────────────
apiKeysRouter.delete(
  "/api-keys/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { rows } = await pool.query(
      `UPDATE api_keys SET revoked_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [req.params.id, req.user!.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "key_not_found_or_already_revoked" });
    }

    return res.json({ revoked: true });
  }
);
