import { Request, Response, NextFunction } from "express";
import { redis } from "../cache/redis";

interface RateLimitOptions {
  windowSeconds: number;
  maxRequests: number;
}

export function createRateLimiter(options: RateLimitOptions) {
  const { windowSeconds, maxRequests } = options;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const identifier = (req.user as any)?.tenantId || req.ip || "anonymous";
    const key = `rate_limit:${identifier}`;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    try {
      const pipeline = redis.pipeline();
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zcard(key);
      pipeline.zadd(key, now, `${now}-${Math.random()}`);
      pipeline.expire(key, windowSeconds * 2);

      const results = await pipeline.exec();
      const requestCount = (results?.[1]?.[1] as number) || 0;

      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - requestCount - 1));
      res.setHeader("X-RateLimit-Reset", Math.ceil((now + windowSeconds * 1000) / 1000));

      if (requestCount >= maxRequests) {
        res.setHeader("Retry-After", windowSeconds);
        return res.status(429).json({
          error: "rate_limit_exceeded",
          message: `Too many requests. Limit is ${maxRequests} per ${windowSeconds} seconds.`,
          retryAfter: windowSeconds,
        });
      }

      return next();
    } catch (err) {
      console.error("[rate-limit] Redis error, failing open:", err);
      return next();
    }
  };
}

export const apiRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests: 1000,
});

export const strictRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests: 100,
});

