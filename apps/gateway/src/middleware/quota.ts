import { Request, Response, NextFunction } from "express";
import { checkDeviceQuota } from "../services/planEnforcement";

/**
 * Blocks device creation when tenant is at their plan's device limit.
 * Wraps checkDeviceQuota from planEnforcement for use as Express middleware.
 */
export async function deviceQuotaMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const tenantId = req.user?.tenantId;
  if (!tenantId) return next();

  try {
    const result = await checkDeviceQuota(tenantId);
    if (!result.allowed) {
      return res.status(402).json({
        error: "device_quota_exceeded",
        limit: result.maxDevices,
        current: result.currentCount,
        plan: result.plan,
        message: result.message,
      });
    }
    return next();
  } catch (err) {
    console.error("[quota] device check failed, failing open:", err);
    return next();
  }
}
