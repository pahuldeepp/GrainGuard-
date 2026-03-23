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

/**
 * Check whether the tenant can register another device based on their plan.
 * Free tier: 5 devices.  Starter: 10.  Professional: 100.  Enterprise: unlimited.
 */
export async function checkDeviceQuota(tenantId: string): Promise<QuotaResult> {
  // Get tenant plan and current device count in a single round-trip
  const { rows } = await pool.query(
    `SELECT t.plan,
            (SELECT COUNT(*) FROM devices WHERE tenant_id = $1) AS device_count
     FROM tenants t
     WHERE t.id = $1`,
    [tenantId]
  );

  if (rows.length === 0) {
    return { allowed: false, currentCount: 0, maxDevices: 0, plan: "unknown", message: "Tenant not found" };
  }

  const plan = rows[0].plan as string;
  const currentCount = parseInt(rows[0].device_count, 10);

  // Determine max devices for plan
  let maxDevices: number;
  if (plan === "enterprise") {
    maxDevices = -1; // unlimited
  } else if (plan in PLANS) {
    maxDevices = PLANS[plan as keyof typeof PLANS].devices;
  } else {
    // Free tier or unknown plan
    maxDevices = FREE_DEVICE_LIMIT;
  }

  // Unlimited
  if (maxDevices === -1) {
    return { allowed: true, currentCount, maxDevices, plan };
  }

  if (currentCount >= maxDevices) {
    return {
      allowed: false,
      currentCount,
      maxDevices,
      plan,
      message: `Device limit reached (${currentCount}/${maxDevices}). Upgrade your plan to add more devices.`,
    };
  }

  return { allowed: true, currentCount, maxDevices, plan };
}
