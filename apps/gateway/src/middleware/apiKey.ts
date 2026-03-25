import { Request, Response, NextFunction } from "express";
import { pool } from "../database/db";
import { redis } from "../cache/redis";

// Devices in the field use X-Api-Key instead of OAuth Bearer tokens.
// Key is looked up in Redis (cache) → Postgres (source of truth).
// Resolved tenant is injected into req.user so downstream handlers
// don't need to know which auth method was used.

const CACHE_TTL = 300; // 5 minutes

async function resolveTenant(apiKey: string): Promise<{ tenantId: string; keyId: string } | null> {
  const cacheKey = `apikey:${apiKey}`;

  // 1. Redis cache hit
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* fall through */ }
  }

  // 2. Postgres lookup
  const result = await pool.query(
    `SELECT id, tenant_id FROM api_keys
     WHERE key_hash = encode(sha256($1::bytea), 'hex')
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [apiKey]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const value = { tenantId: row.tenant_id, keyId: row.id };

  // 3. Warm cache
  await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(value)).catch(() => {});

  return value;
}

export async function apiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const key = req.headers["x-api-key"] as string | undefined;

  if (!key) {
    res.status(401).json({ error: "missing_api_key" });
    return;
  }

  // Add constant-time delay to prevent timing attacks on key enumeration
  const startTime = Date.now();
  const constantDelay = 50 + Math.random() * 50; // 50-100ms random delay

  try {
    const resolved = await resolveTenant(key);

    // Ensure constant-time response regardless of hit/miss
    const elapsed = Date.now() - startTime;
    const remainingDelay = Math.max(0, constantDelay - elapsed);
    if (remainingDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingDelay));
    }

    if (!resolved) {
      res.status(401).json({ error: "invalid_api_key" });
      return;
    }

    req.user = {
      sub: `apikey:${resolved.keyId}`,
      tenantId: resolved.tenantId,
      roles: ["device"],
      scopes: ["telemetry:write"],
    };

    next();
  } catch (err) {
    // Even on error, maintain constant-time response
    const elapsed = Date.now() - startTime;
    const remainingDelay = Math.max(0, constantDelay - elapsed);
    if (remainingDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingDelay));
    }

    console.error("[api-key] lookup error:", err);
    res.status(500).json({ error: "internal_error" });
  }
}
