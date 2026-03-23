// Pass-through mock — rate limiters are a no-op in tests.
import type { Request, Response, NextFunction } from "express";

const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();

export const apiRateLimiter    = passThrough;
export const publicRateLimiter = passThrough;
export const billingRateLimiter = passThrough;
export const bulkRateLimiter   = passThrough;
export const ingestRateLimiter = passThrough;
