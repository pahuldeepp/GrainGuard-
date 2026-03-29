import { Request, Response, NextFunction } from "express";
import { pool } from "../database/db";
import { redis } from "../cache/redis";
import { PLANS } from "../services/stripe";

// ─── Plan tier feature matrix ─────────────────────────────────────────────────

interface PlanLimits {
  devices: number;          // -1 = unlimited
  alertRules: number;
  bulkImport: boolean;
  sso: boolean;
  auditLogExport: boolean;
  apiRateLimit: number;
  webhooks: boolean;
}

const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    devices: 5,
    alertRules: 3,
    bulkImport: false,
    sso: false,
    auditLogExport: false,
    apiRateLimit: 100,
    webhooks: false,
  },
  starter: {
    devices: PLANS.starter.devices,      // 10
    alertRules: 10,
    bulkImport: true,
    sso: false,
    auditLogExport: false,
    apiRateLimit: 500,
    webhooks: true,
  },
  professional: {
    devices: PLANS.professional.devices, // 100
    alertRules: 50,
    bulkImport: true,
    sso: true,
    auditLogExport: true,
    apiRateLimit: 2000,
    webhooks: true,
  },
  enterprise: {
    devices: PLANS.enterprise.devices,   // -1
    alertRules: -1,
    bulkImport: true,
    sso: true,
    auditLogExport: true,
    apiRateLimit: 10000,
    webhooks: true,
  },
};

// ─── Tenant plan cache (Redis, 5 min TTL) ─────────────────────────────────────

interface TenantPlan {
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
}

const CACHE_TTL = 300; // 5 minutes

async function getTenantPlan(tenantId: string): Promise<TenantPlan> {
  const cacheKey = `tenant_plan:${tenantId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as TenantPlan;
  } catch {
    // Redis unavailable — fall through to DB
  }

  const { rows } = await pool.query(
    `SELECT plan, subscription_status, current_period_end
     FROM tenants WHERE id = $1`,
    [tenantId]
  );

  if (rows.length === 0) {
    return { plan: "free", subscriptionStatus: "none", currentPeriodEnd: null };
  }

  const result: TenantPlan = {
    plan: rows[0].plan || "free",
    subscriptionStatus: rows[0].subscription_status || "none",
    currentPeriodEnd: rows[0].current_period_end ?? null,
  };

  try {
    await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
  } catch {
    // Non-critical
  }

  return result;
}

async function getDeviceCount(tenantId: string): Promise<number> {
  const cacheKey = `device_count:${tenantId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return parseInt(cached, 10);
  } catch { /* ignore */ }

  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM devices WHERE tenant_id = $1",
    [tenantId]
  );

  const count: number = rows[0]?.count ?? 0;

  try {
    await redis.set(cacheKey, String(count), "EX", 60);
  } catch { /* ignore */ }

  return count;
}

async function getAlertRuleCount(tenantId: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM alert_rules WHERE tenant_id = $1",
    [tenantId]
  );
  return rows[0]?.count ?? 0;
}

// ─── Cache invalidation ────────────────────────────────────────────────────────

export async function invalidatePlanCache(tenantId: string): Promise<void> {
  try {
    await redis.del(`tenant_plan:${tenantId}`);
    await redis.del(`device_count:${tenantId}`);
  } catch {
    // Non-critical
  }
}

// ─── requireActiveSubscription ────────────────────────────────────────────────

export function requireActiveSubscription() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.tenantId) return next();

    const tenant = await getTenantPlan(req.user.tenantId);

    if (tenant.plan === "free") return next();

    const blocked = ["canceled", "unpaid", "incomplete_expired"];
    if (blocked.includes(tenant.subscriptionStatus)) {
      return res.status(403).json({
        error: "subscription_inactive",
        plan: tenant.plan,
        status: tenant.subscriptionStatus,
        message: "Your subscription is inactive. Please update your billing to continue.",
        upgradeUrl: "/billing",
      });
    }

    if (tenant.subscriptionStatus === "past_due") {
      const periodEnd = tenant.currentPeriodEnd ? new Date(tenant.currentPeriodEnd) : null;
      const gracePeriodEnd = periodEnd
        ? new Date(periodEnd.getTime() + 7 * 24 * 60 * 60 * 1000)
        : null;

      if (gracePeriodEnd && new Date() > gracePeriodEnd) {
        return res.status(403).json({
          error: "subscription_past_due",
          message: "Payment is past due. Service suspended after 7-day grace period.",
          upgradeUrl: "/billing",
        });
      }
    }

    return next();
  };
}

// ─── enforceDeviceQuota ───────────────────────────────────────────────────────

export function enforceDeviceQuota() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = req.user!.tenantId;
    const tenant = await getTenantPlan(tenantId);
    const limits = PLAN_LIMITS[tenant.plan] ?? PLAN_LIMITS.free;

    if (limits.devices === -1) return next();

    const currentCount = await getDeviceCount(tenantId);

    if (currentCount >= limits.devices) {
      return res.status(403).json({
        error: "device_quota_exceeded",
        plan: tenant.plan,
        limit: limits.devices,
        current: currentCount,
        message: `Your ${tenant.plan} plan allows ${limits.devices} devices. You have ${currentCount}.`,
        upgradeUrl: "/billing",
      });
    }

    return next();
  };
}

// ─── enforceBulkDeviceQuota ───────────────────────────────────────────────────

export function enforceBulkDeviceQuota() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = req.user!.tenantId;
    const tenant = await getTenantPlan(tenantId);
    const limits = PLAN_LIMITS[tenant.plan] ?? PLAN_LIMITS.free;

    if (!limits.bulkImport) {
      return res.status(403).json({
        error: "feature_not_available",
        feature: "bulk_import",
        plan: tenant.plan,
        message: "Bulk import is available on Starter plans and above.",
        upgradeUrl: "/billing",
      });
    }

    if (limits.devices !== -1) {
      const currentCount = await getDeviceCount(tenantId);
      if (currentCount >= limits.devices) {
        return res.status(403).json({
          error: "device_quota_exceeded",
          plan: tenant.plan,
          limit: limits.devices,
          current: currentCount,
          upgradeUrl: "/billing",
        });
      }
    }

    return next();
  };
}

// ─── enforceAlertRuleQuota ────────────────────────────────────────────────────

export function enforceAlertRuleQuota() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = req.user!.tenantId;
    const tenant = await getTenantPlan(tenantId);
    const limits = PLAN_LIMITS[tenant.plan] ?? PLAN_LIMITS.free;

    if (limits.alertRules === -1) return next();

    const currentCount = await getAlertRuleCount(tenantId);

    if (currentCount >= limits.alertRules) {
      return res.status(403).json({
        error: "alert_rule_quota_exceeded",
        plan: tenant.plan,
        limit: limits.alertRules,
        current: currentCount,
        message: `Your ${tenant.plan} plan allows ${limits.alertRules} alert rules.`,
        upgradeUrl: "/billing",
      });
    }

    return next();
  };
}

// ─── requireFeature ───────────────────────────────────────────────────────────

export function requireFeature(feature: keyof PlanLimits) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = req.user!.tenantId;
    const tenant = await getTenantPlan(tenantId);
    const limits = PLAN_LIMITS[tenant.plan] ?? PLAN_LIMITS.free;

    const value = limits[feature];

    if (value === false) {
      return res.status(403).json({
        error: "feature_not_available",
        feature,
        plan: tenant.plan,
        message: `${String(feature)} is not available on your ${tenant.plan} plan.`,
        upgradeUrl: "/billing",
      });
    }

    return next();
  };
}

export { PLAN_LIMITS };
export type { PlanLimits, TenantPlan };
