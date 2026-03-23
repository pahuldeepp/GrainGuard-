import { Channel } from "amqplib";
import { QUEUES, EmailJob } from "../queues";
import { db } from "../db";

// Default: run weekly (every 7 days). Override with DIGEST_INTERVAL_MS env var.
const DIGEST_INTERVAL_MS =
  parseInt(process.env.DIGEST_INTERVAL_MS || "", 10) ||
  7 * 24 * 60 * 60 * 1000;

/**
 * Gather digest data for a tenant and send a summary email to each
 * user who has email_weekly_digest = true.
 */
async function sendDigestForTenant(
  tenantId: string,
  tenantName: string,
  channel: Channel
): Promise<number> {
  // 1. Find users who opted in to weekly digest
  const { rows: users } = await db.query(
    `SELECT tu.email, np.alert_levels
     FROM tenant_users tu
     JOIN notification_preferences np
       ON np.tenant_id = tu.tenant_id AND np.user_id = tu.auth_user_id
     WHERE tu.tenant_id = $1 AND np.email_weekly_digest = TRUE`,
    [tenantId]
  );

  if (users.length === 0) return 0;

  // 2. Gather stats for the past 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [alertCountResult, deviceCountResult, criticalResult] =
    await Promise.all([
      db.query(
        `SELECT COUNT(*) AS cnt FROM audit_events
         WHERE tenant_id = $1 AND event_type LIKE 'alert%' AND created_at >= $2`,
        [tenantId, weekAgo]
      ),
      db.query(
        "SELECT COUNT(*) AS cnt FROM devices WHERE tenant_id = $1",
        [tenantId]
      ),
      db.query(
        `SELECT COUNT(*) AS cnt FROM audit_events
         WHERE tenant_id = $1 AND event_type LIKE 'alert%'
           AND created_at >= $2
           AND payload->>'level' = 'critical'`,
        [tenantId, weekAgo]
      ),
    ]);

  const alertCount = parseInt(alertCountResult.rows[0]?.cnt || "0", 10);
  const deviceCount = parseInt(deviceCountResult.rows[0]?.cnt || "0", 10);
  const criticalCount = parseInt(criticalResult.rows[0]?.cnt || "0", 10);

  // 3. Build HTML digest
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#16a34a">GrainGuard Weekly Digest</h2>
      <p>Here's your weekly summary for <strong>${tenantName}</strong>:</p>

      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr style="background:#f3f4f6">
          <td style="padding:8px 12px;border:1px solid #e5e7eb"><strong>Total Devices</strong></td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb">${deviceCount}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #e5e7eb"><strong>Alerts (7d)</strong></td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb">${alertCount}</td>
        </tr>
        <tr style="background:#f3f4f6">
          <td style="padding:8px 12px;border:1px solid #e5e7eb"><strong>Critical Alerts (7d)</strong></td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;${criticalCount > 0 ? "color:#dc2626;font-weight:bold" : ""}">${criticalCount}</td>
        </tr>
      </table>

      ${criticalCount > 0 ? '<p style="color:#dc2626">⚠️ You had critical alerts this week. Review them in your dashboard.</p>' : '<p style="color:#16a34a">✅ No critical alerts this week.</p>'}

      <p style="margin-top:24px">
        <a href="${process.env.DASHBOARD_URL || "https://app.grainguard.com"}"
           style="background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px">
          Open Dashboard
        </a>
      </p>

      <hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb"/>
      <p style="color:#9ca3af;font-size:12px">
        You're receiving this because you enabled weekly digests.
        <a href="${process.env.DASHBOARD_URL || "https://app.grainguard.com"}/settings">Manage preferences</a>
      </p>
    </div>
  `.trim();

  // 4. Publish an email job for each opted-in user
  for (const user of users) {
    const emailJob: EmailJob = {
      to: user.email,
      type: "usage_warning", // closest existing type for digest
      subject: `GrainGuard Weekly Digest — ${tenantName}`,
      body: html,
      tenantId,
    };

    channel.sendToQueue(
      QUEUES.EMAILS,
      Buffer.from(JSON.stringify(emailJob)),
      { persistent: true }
    );
  }

  return users.length;
}

/**
 * Run the digest cycle for all tenants that have users subscribed.
 */
async function runDigestCycle(channel: Channel): Promise<void> {
  console.log("[digest] starting weekly digest cycle");

  try {
    // Find all tenants that have at least one user with email_weekly_digest
    const { rows: tenants } = await db.query(
      `SELECT DISTINCT t.id, t.name
       FROM tenants t
       JOIN notification_preferences np ON np.tenant_id = t.id
       WHERE np.email_weekly_digest = TRUE`
    );

    let totalEmails = 0;

    for (const tenant of tenants) {
      try {
        const count = await sendDigestForTenant(
          tenant.id,
          tenant.name,
          channel
        );
        totalEmails += count;
        console.log(
          `[digest] tenant=${tenant.name} — ${count} digest emails queued`
        );
      } catch (err) {
        console.error(
          `[digest] error processing tenant ${tenant.id}:`,
          err
        );
      }
    }

    console.log(
      `[digest] cycle complete — ${tenants.length} tenants, ${totalEmails} emails`
    );
  } catch (err) {
    console.error("[digest] cycle failed:", err);
  }
}

/**
 * Start the digest scheduler. Runs the digest cycle immediately on startup
 * (if DIGEST_RUN_ON_START=true) then every DIGEST_INTERVAL_MS.
 */
export function startDigestScheduler(channel: Channel): void {
  console.log(
    `[digest] scheduler started — interval=${Math.round(DIGEST_INTERVAL_MS / 3600000)}h`
  );

  // Run on a regular interval
  const timer = setInterval(() => {
    runDigestCycle(channel).catch((err) =>
      console.error("[digest] unhandled error:", err)
    );
  }, DIGEST_INTERVAL_MS);

  timer.unref(); // don't block process exit

  // Optionally run immediately on startup (useful for testing)
  if (process.env.DIGEST_RUN_ON_START === "true") {
    runDigestCycle(channel).catch((err) =>
      console.error("[digest] initial run failed:", err)
    );
  }
}
