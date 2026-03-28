import { writePool as pool } from "../database/db";
import { PLANS } from "./stripe";

interface QuotaResult {
  allowed: boolean;
  currentCount: number;
  maxDevices: number;
  plan: string;
  message?: string;
}

const FREE_DEVICE_LIMIT = 5;
const BILLING_GRACE_STATUSES = new Set(["past_due", "cancelled"]);

function isPaidPlan(plan: string): plan is keyof typeof PLANS {
  return Object.prototype.hasOwnProperty.call(PLANS, plan);
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function hasPaidAccess(
  plan: string,
  subscriptionStatus: string,
  currentPeriodEnd: Date | null,
): boolean {
  if (!isPaidPlan(plan)) {
    return false;
  }

  if (subscriptionStatus === "active" || subscriptionStatus === "trialing") {
    return true;
  }

  return (
    BILLING_GRACE_STATUSES.has(subscriptionStatus) &&
    currentPeriodEnd != null &&
    currentPeriodEnd.getTime() > Date.now()
  );
}

function quotaLimitForPlan(plan: string): number {
  if (plan === "enterprise") {
    return -1;
  }
  if (isPaidPlan(plan)) {
    return PLANS[plan].devices;
  }
  return FREE_DEVICE_LIMIT;
}

export async function checkDeviceQuota(tenantId: string): Promise<QuotaResult> {
  const { rows } = await pool.query(
    `SELECT t.plan,
            t.subscription_status,
            t.current_period_end,
            (SELECT COUNT(*) FROM devices WHERE tenant_id = $1) AS device_count
       FROM tenants t
      WHERE t.id = $1`,
    [tenantId],
  );

  if (rows.length === 0) {
    return {
      allowed: false,
      currentCount: 0,
      maxDevices: 0,
      plan: "unknown",
      message: "Tenant not found",
    };
  }

  const storedPlan = rows[0].plan as string;
  const subscriptionStatus = (rows[0].subscription_status as string) || "none";
  const currentPeriodEnd = parseDate(rows[0].current_period_end);
  const currentCount = parseInt(rows[0].device_count as string, 10);

  const effectivePlan = hasPaidAccess(
    storedPlan,
    subscriptionStatus,
    currentPeriodEnd,
  )
    ? storedPlan
    : "free";
  const maxDevices = quotaLimitForPlan(effectivePlan);

  if (maxDevices === -1) {
    return { allowed: true, currentCount, maxDevices, plan: effectivePlan };
  }

  if (currentCount >= maxDevices) {
    const graceMessage =
      effectivePlan === "free" && storedPlan !== "free"
        ? `Your ${storedPlan} plan is no longer granting paid-device capacity. Device limit reached (${currentCount}/${maxDevices}).`
        : `Device limit reached (${currentCount}/${maxDevices}). Upgrade your plan to add more devices.`;

    return {
      allowed: false,
      currentCount,
      maxDevices,
      plan: effectivePlan,
      message: graceMessage,
    };
  }

  return { allowed: true, currentCount, maxDevices, plan: effectivePlan };
}
