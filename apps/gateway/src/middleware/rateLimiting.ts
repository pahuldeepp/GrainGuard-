import { Request, Response, NextFunction } from "express";
import { redis } from "../cache/redis";

interface RateLimitOptions {
  windowSeconds: number;
  maxRequests: number;
  /** Namespace prefix so different endpoint groups have isolated buckets */
  keyPrefix?: string;
}

export function createRateLimiter(options: RateLimitOptions) {
  const { windowSeconds, maxRequests, keyPrefix = "api" } = options;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    // ── Identifier priority ───────────────────────────────────────────────────
    // 1. Authenticated tenant   → best: isolates per paying customer
    // 2. Authenticated user sub → fallback if tenantId missing
    // 3. Real IP (x-forwarded)  → for unauthenticated / pre-auth routes
    // 4. "anonymous"            → last resort
    const tenantId = req.user?.tenantId;
    const userId   = req.user?.sub;
    const realIp   = (req.headers["x-forwarded-for"] as string)
      ?.split(",")[0]
      .trim() ?? req.ip ?? "anonymous";

    const identifier = tenantId
      ? `tenant:${tenantId}`
      : userId
        ? `user:${userId}`
        : `ip:${realIp}`;

    // ── Per-endpoint bucket so billing quota doesn't bleed into device API ───
    const key = `rl:${keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    try {
      const pipeline = redis.pipeline();
      pipeline.zremrangebyscore(key, 0, windowStart);       // evict old entries
      pipeline.zcard(key);                                  // count in window
      pipeline.zadd(key, now, `${now}-${Math.random()}`);  // record this request
      pipeline.expire(key, windowSeconds * 2);              // auto-cleanup

      const results = await pipeline.exec();
      const requestCount = (results?.[1]?.[1] as number) ?? 0;

      const remaining = Math.max(0, maxRequests - requestCount - 1);
      const reset     = Math.ceil((now + windowSeconds * 1000) / 1000);

      res.setHeader("X-RateLimit-Limit",     maxRequests);
      res.setHeader("X-RateLimit-Remaining", remaining);
      res.setHeader("X-RateLimit-Reset",     reset);
      res.setHeader("X-RateLimit-Policy",    `${maxRequests};w=${windowSeconds}`);

      if (requestCount >= maxRequests) {
        res.setHeader("Retry-After", windowSeconds);
        return res.status(429).json({
          error:      "rate_limit_exceeded",
          message:    `Too many requests. Limit: ${maxRequests} per ${windowSeconds}s.`,
          retryAfter: windowSeconds,
          requestId:  req.requestId,
        });
      }

      return next();
    } catch (err) {
      // Fail open — don't block traffic if Redis is down
      console.error("[rate-limit] Redis error, failing open:", err);
      return next();
    }
  };
}

// ── Named limiters for each traffic tier ──────────────────────────────────────

/** Standard authenticated API calls (devices, telemetry queries) */
export const apiRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests:   1000,
  keyPrefix:     "api",
});

/** Bulk / expensive operations (CSV import, SSO config) */
export const bulkRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests:   20,
  keyPrefix:     "bulk",
});

/** Billing mutations (checkout, subscription changes) */
export const billingRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests:   30,
  keyPrefix:     "billing",
});

/** Public pre-auth endpoints (tenant registration, health) — keyed by IP */
export const publicRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests:   10,
  keyPrefix:     "public",
});

/** IoT device ingest — high throughput per device/tenant */
export const ingestRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests:   500,
  keyPrefix:     "ingest",
});
