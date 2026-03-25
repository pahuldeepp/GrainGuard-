import { Channel } from "amqplib";
import { QUEUES, AlertJob, EmailJob, WebhookJob } from "../queues";
import { db } from "../db";

const MAX_RETRIES = 3;

function retryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  return Math.min(Math.random() * base + base, 30000);
}

/**
 * Check if a recipient should receive email alerts based on their
 * notification preferences. Returns true if no preferences are set
 * (default: send alerts).
 */
async function shouldSendEmail(
  tenantId: string,
  recipientEmail: string,
  alertLevel: string
): Promise<boolean> {
  try {
    // Look up user_id from tenant_users
    const { rows: userRows } = await db.query(
      `SELECT tu.auth_user_id
       FROM tenant_users tu
       WHERE tu.tenant_id = $1 AND LOWER(tu.email) = LOWER($2)`,
      [tenantId, recipientEmail]
    );

    if (userRows.length === 0) {
      // User not found in DB — send email anyway (could be an external recipient)
      return true;
    }

    const userId = userRows[0].auth_user_id;

    // Check notification preferences
    const { rows: prefRows } = await db.query(
      `SELECT email_alerts, alert_levels
       FROM notification_preferences
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId]
    );

    if (prefRows.length === 0) {
      // No preferences set — use defaults (send all alerts)
      return true;
    }

    const prefs = prefRows[0];

    // Check if email alerts are enabled
    if (!prefs.email_alerts) return false;

    // Check if the alert level is in the user's preferred levels
    const levels: string[] = prefs.alert_levels || ["warn", "critical"];
    if (alertLevel && !levels.includes(alertLevel)) return false;

    return true;
  } catch (err) {
    // On DB error, default to sending (fail open for alerts)
    console.error("[alert] pref check failed, defaulting to send:", err);
    return true;
  }
}

/**
 * Fetch enabled webhook endpoints for a tenant that subscribe to telemetry.alert
 * events, and publish a WebhookJob for each.
 */
async function fanOutToWebhooks(
  job: AlertJob,
  channel: Channel
): Promise<number> {
  try {
    const { rows: endpoints } = await db.query(
      `SELECT id, url, secret, event_types
       FROM webhook_endpoints
       WHERE tenant_id = $1
         AND enabled = TRUE
         AND 'telemetry.alert' = ANY(event_types)`,
      [job.tenantId]
    );

    for (const ep of endpoints) {
      const webhookJob: WebhookJob = {
        url: ep.url,
        secret: ep.secret,
        tenantId: job.tenantId,
        eventType: "telemetry.alert",
        endpointId: ep.id,
        attempt: 0,
        payload: {
          event: "telemetry.alert",
          timestamp: new Date().toISOString(),
          data: {
            deviceId: job.deviceId,
            serialNumber: job.serialNumber,
            alertType: job.alertType,
            value: job.value,
            threshold: job.threshold,
            level: job.level || "warn",
            score: job.score,
          },
        },
      };

      channel.sendToQueue(
        QUEUES.WEBHOOKS,
        Buffer.from(JSON.stringify(webhookJob)),
        { persistent: true }
      );

      console.log(
        `[alert] queued webhook delivery to ${ep.url} endpoint=${ep.id}`
      );
    }

    return endpoints.length;
  } catch (err) {
    console.error("[alert] webhook fan-out failed:", err);
    return 0;
  }
}

async function processAlert(job: AlertJob, channel: Channel): Promise<void> {
  const alertLevel = job.level || "warn";

  console.log(
    `[alert] ${job.alertType} alert device=${job.serialNumber} ` +
      `value=${job.value} threshold=${job.threshold} level=${alertLevel} ` +
      `tenant=${job.tenantId}`
  );

  // ── Fan out to email recipients (respecting notification preferences) ──
  let emailsSent = 0;
  for (const recipient of job.recipients) {
    const allowed = await shouldSendEmail(job.tenantId, recipient, alertLevel);
    if (!allowed) {
      console.log(
        `[alert] skipping email to ${recipient} — preferences opted out`
      );
      continue;
    }

    const emailJob: EmailJob = {
      to: recipient,
      type: "alert",
      subject: `GrainGuard Alert: ${job.alertType} threshold exceeded on ${job.serialNumber}`,
      body: `
        <h2>Alert: ${job.alertType} threshold exceeded</h2>
        <p><strong>Device:</strong> ${job.serialNumber}</p>
        <p><strong>Current value:</strong> ${job.value}</p>
        <p><strong>Threshold:</strong> ${job.threshold}</p>
        <p><strong>Severity:</strong> ${alertLevel}</p>
        <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        <hr/>
        <p style="color:#888;font-size:12px">
          You can manage alert preferences in your
          <a href="${process.env.DASHBOARD_URL || "https://app.grainguard.com"}/settings">Settings</a>.
        </p>
      `.trim(),
      tenantId: job.tenantId,
    };

    channel.sendToQueue(
      QUEUES.EMAILS,
      Buffer.from(JSON.stringify(emailJob)),
      { persistent: true }
    );

    emailsSent++;
    console.log(`[alert] queued email notification to ${recipient}`);
  }

  // ── Fan out to webhook endpoints ──
  const webhookCount = await fanOutToWebhooks(job, channel);

  console.log(
    `[alert] processed — ${emailsSent}/${job.recipients.length} emails, ` +
      `${webhookCount} webhooks`
  );
}

export function startAlertWorker(channel: Channel): void {
  channel.consume(QUEUES.ALERTS, async (msg) => {
    if (!msg) return;

    let job: AlertJob;

    try {
      job = JSON.parse(msg.content.toString()) as AlertJob;
    } catch {
      console.error("[alert] malformed message — sending to DLQ");
      channel.nack(msg, false, false);
      return;
    }

    const attempt =
      (msg.properties.headers?.["x-retry-count"] as number) || 0;

    try {
      await processAlert(job, channel);
      channel.ack(msg);
    } catch (err) {
      console.error(
        `[alert] failed attempt ${attempt + 1}/${MAX_RETRIES}:`,
        err
      );

      if (attempt >= MAX_RETRIES - 1) {
        console.error(`[alert] max retries exceeded — routing to DLQ`);
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        console.log(`[alert] retrying in ${Math.round(delay)}ms`);
        setTimeout(() => {
          channel.nack(msg, false, false);
          channel.sendToQueue(QUEUES.ALERTS, msg.content, {
            persistent: true,
            headers: { "x-retry-count": attempt + 1 },
          });
        }, delay);
      }
    }
  });

  console.log(`[alert] worker listening on ${QUEUES.ALERTS}`);
}
