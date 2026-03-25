import { Channel } from "amqplib";
import { QUEUES, AlertJob, EmailJob, WebhookJob } from "../queues";
import { db } from "../db";

const MAX_RETRIES = 3;

function retryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  return Math.min(Math.random() * base + base, 30000);
}

interface NotificationPref {
  email: string;
  email_alerts: boolean;
  alert_levels: string[];
}

interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  event_types: string[];
}

/**
 * Look up notification preferences for the given recipient emails within a tenant.
 * Joins tenant_users -> notification_preferences to get per-user prefs.
 */
async function getRecipientPrefs(tenantId: string, emails: string[]): Promise<NotificationPref[]> {
  if (emails.length === 0) return [];

  const result = await db.query<NotificationPref>(
    `SELECT tu.email, np.email_alerts, np.alert_levels
     FROM tenant_users tu
     JOIN notification_preferences np ON np.user_id = tu.id
     WHERE tu.tenant_id = $1
       AND tu.email = ANY($2)`,
    [tenantId, emails]
  );

  return result.rows;
}

/**
 * Fetch enabled webhook endpoints for a tenant that listen to telemetry.alert events.
 */
async function getWebhookEndpoints(tenantId: string): Promise<WebhookEndpoint[]> {
  const result = await db.query<WebhookEndpoint>(
    `SELECT id, url, secret, event_types
     FROM webhook_endpoints
     WHERE tenant_id = $1
       AND enabled = true
       AND event_types @> ARRAY['telemetry.alert']::text[]`,
    [tenantId]
  );

  return result.rows;
}

async function processAlert(job: AlertJob, channel: Channel): Promise<void> {
  console.log(`[alert] ${job.alertType} alert device=${job.serialNumber} value=${job.value} threshold=${job.threshold} tenant=${job.tenantId}`);

  const alertLevel = job.level || job.alertType;

  // --- Email notifications with preference checks ---
  const prefs = await getRecipientPrefs(job.tenantId, job.recipients);
  const prefsByEmail = new Map(prefs.map((p) => [p.email, p]));

  let emailCount = 0;

  for (const recipient of job.recipients) {
    const pref = prefsByEmail.get(recipient);

    // If no prefs found for user, skip (default deny)
    if (!pref) {
      console.log(`[alert] skipping ${recipient} — no notification preferences found`);
      continue;
    }

    // Check email_alerts is enabled
    if (!pref.email_alerts) {
      console.log(`[alert] skipping ${recipient} — email_alerts disabled`);
      continue;
    }

    // Check alert level is in the user's subscribed levels
    if (pref.alert_levels && !pref.alert_levels.includes(alertLevel)) {
      console.log(`[alert] skipping ${recipient} — level "${alertLevel}" not in user's alert_levels`);
      continue;
    }

    const emailJob: EmailJob = {
      to: recipient,
      type: "alert",
      subject: `GrainGuard Alert: ${job.alertType} threshold exceeded on ${job.serialNumber}`,
      body: `
        Device ${job.serialNumber} has exceeded the ${job.alertType} threshold.
        Current value: ${job.value}
        Threshold: ${job.threshold}
        Time: ${new Date().toISOString()}
      `.trim(),
      tenantId: job.tenantId,
    };

    channel.sendToQueue(
      QUEUES.EMAILS,
      Buffer.from(JSON.stringify(emailJob)),
      { persistent: true }
    );

    console.log(`[alert] queued email notification to ${recipient}`);
    emailCount++;
  }

  // --- Webhook notifications ---
  const endpoints = await getWebhookEndpoints(job.tenantId);
  let webhookCount = 0;

  for (const endpoint of endpoints) {
    const webhookJob: WebhookJob = {
      url: endpoint.url,
      secret: endpoint.secret,
      eventType: "telemetry.alert",
      tenantId: job.tenantId,
      endpointId: endpoint.id,
      attempt: 0,
      payload: {
        alertType: job.alertType,
        level: alertLevel,
        deviceId: job.deviceId,
        serialNumber: job.serialNumber,
        value: job.value,
        threshold: job.threshold,
        timestamp: new Date().toISOString(),
      },
    };

    channel.sendToQueue(
      QUEUES.WEBHOOKS,
      Buffer.from(JSON.stringify(webhookJob)),
      { persistent: true }
    );

    console.log(`[alert] queued webhook to ${endpoint.url} (endpoint=${endpoint.id})`);
    webhookCount++;
  }

  console.log(`[alert] processed — ${emailCount} emails, ${webhookCount} webhooks queued`);
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

    const attempt = (msg.properties.headers?.["x-retry-count"] as number) || 0;

    try {
      await processAlert(job, channel);
      channel.ack(msg);
    } catch (err) {
      console.error(`[alert] failed attempt ${attempt + 1}/${MAX_RETRIES}:`, err);

      if (attempt >= MAX_RETRIES - 1) {
        console.error(`[alert] max retries exceeded — routing to DLQ`);
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        console.log(`[alert] retrying in ${Math.round(delay)}ms`);
        setTimeout(() => {
          channel.nack(msg, false, false);
          channel.sendToQueue(
            QUEUES.ALERTS,
            msg.content,
            {
              persistent: true,
              headers: { "x-retry-count": attempt + 1 },
            }
          );
        }, delay);
      }
    }
  });

  console.log(`[alert] worker listening on ${QUEUES.ALERTS}`);
}
