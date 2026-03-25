import { Channel } from "amqplib";
import { QUEUES, EmailJob } from "../queues";
import { db } from "../db";

const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

interface DigestUser {
  user_id: string;
  email: string;
  tenant_id: string;
}

interface TenantDigestData {
  alertCount: number;
  deviceCount: number;
  criticalDevices: Array<{ serial_number: string; alert_type: string; value: number }>;
}

/**
 * Fetch all users who have opted in to the weekly email digest.
 */
async function getDigestSubscribers(): Promise<DigestUser[]> {
  const result = await db.query<DigestUser>(
    `SELECT np.user_id, tu.email, tu.tenant_id
     FROM notification_preferences np
     JOIN tenant_users tu ON tu.id = np.user_id
     WHERE np.email_weekly_digest = true`
  );
  return result.rows;
}

/**
 * Gather digest stats for a single tenant over the past 7 days.
 */
async function getTenantDigestData(tenantId: string): Promise<TenantDigestData> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [alertResult, deviceResult, criticalResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM alerts
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, sevenDaysAgo]
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM devices
       WHERE tenant_id = $1`,
      [tenantId]
    ),
    db.query<{ serial_number: string; alert_type: string; value: number }>(
      `SELECT DISTINCT ON (d.serial_number) d.serial_number, a.alert_type, a.value
       FROM alerts a
       JOIN devices d ON d.id = a.device_id
       WHERE a.tenant_id = $1
         AND a.created_at >= $2
         AND a.level = 'critical'
       ORDER BY d.serial_number, a.created_at DESC`,
      [tenantId, sevenDaysAgo]
    ),
  ]);

  return {
    alertCount: parseInt(alertResult.rows[0]?.count || "0", 10),
    deviceCount: parseInt(deviceResult.rows[0]?.count || "0", 10),
    criticalDevices: criticalResult.rows,
  };
}

/**
 * Build an HTML digest email body.
 */
function buildDigestHtml(tenantId: string, data: TenantDigestData): string {
  const criticalSection =
    data.criticalDevices.length > 0
      ? `
        <h3>Critical Devices</h3>
        <ul>
          ${data.criticalDevices
            .map(
              (d) =>
                `<li><strong>${d.serial_number}</strong> &mdash; ${d.alert_type} at ${d.value}</li>`
            )
            .join("\n          ")}
        </ul>`
      : "<p>No critical device readings this week.</p>";

  return `
    <h2>GrainGuard Weekly Digest</h2>
    <p>Here is your weekly summary for tenant <strong>${tenantId}</strong>:</p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;">
      <tr><td><strong>Total Alerts (7 days)</strong></td><td>${data.alertCount}</td></tr>
      <tr><td><strong>Active Devices</strong></td><td>${data.deviceCount}</td></tr>
      <tr><td><strong>Critical Devices</strong></td><td>${data.criticalDevices.length}</td></tr>
    </table>
    ${criticalSection}
    <p style="color:#888;font-size:12px;">
      This digest is sent weekly. Manage your preferences in the GrainGuard dashboard.
    </p>
  `.trim();
}

/**
 * Run one cycle of the digest: fetch subscribers, gather data, publish emails.
 */
async function runDigestCycle(channel: Channel): Promise<void> {
  console.log("[digest] starting weekly digest cycle");

  const subscribers = await getDigestSubscribers();

  if (subscribers.length === 0) {
    console.log("[digest] no subscribers — skipping");
    return;
  }

  // Group subscribers by tenant to avoid redundant queries
  const byTenant = new Map<string, DigestUser[]>();
  for (const sub of subscribers) {
    const list = byTenant.get(sub.tenant_id) || [];
    list.push(sub);
    byTenant.set(sub.tenant_id, list);
  }

  let emailCount = 0;

  for (const [tenantId, users] of byTenant) {
    let data: TenantDigestData;
    try {
      data = await getTenantDigestData(tenantId);
    } catch (err) {
      console.error(`[digest] failed to gather data for tenant=${tenantId}:`, err);
      continue;
    }

    const html = buildDigestHtml(tenantId, data);

    for (const user of users) {
      const emailJob: EmailJob = {
        to: user.email,
        type: "usage_warning", // closest existing type for digest emails
        subject: `GrainGuard Weekly Digest — ${data.alertCount} alerts, ${data.deviceCount} devices`,
        body: html,
        tenantId,
      };

      channel.sendToQueue(
        QUEUES.EMAILS,
        Buffer.from(JSON.stringify(emailJob)),
        { persistent: true }
      );

      emailCount++;
    }

    console.log(`[digest] queued ${users.length} digest emails for tenant=${tenantId}`);
  }

  console.log(`[digest] cycle complete — ${emailCount} total emails queued`);
}

/**
 * Start the digest scheduler. Runs the digest cycle on a configurable interval.
 */
export function startDigestScheduler(channel: Channel): void {
  const intervalMs = parseInt(process.env.DIGEST_INTERVAL_MS || "", 10) || DEFAULT_INTERVAL_MS;

  console.log(`[digest] scheduler started — interval=${intervalMs}ms (${Math.round(intervalMs / 3600000)}h)`);

  // Run on interval
  setInterval(async () => {
    try {
      await runDigestCycle(channel);
    } catch (err) {
      console.error("[digest] cycle failed:", err);
    }
  }, intervalMs);
}
