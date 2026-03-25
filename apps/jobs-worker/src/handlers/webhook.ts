import { Channel } from "amqplib";
import { createHmac } from "crypto";
import { QUEUES, WebhookJob } from "../queues";
import { db } from "../db";

const MAX_RETRIES = 5;

// Sign payload with HMAC-SHA256
// Customer verifies: HMAC(secret, payload) === X-GrainGuard-Signature header
function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
}

// Jittered backoff
function retryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  return Math.min(Math.random() * base + base, 60000); // cap at 60s
}

/**
 * Record a webhook delivery attempt in the webhook_deliveries table.
 */
async function recordDelivery(
  endpointId: string | undefined,
  eventType: string,
  attempt: number,
  statusCode: number | null,
  success: boolean,
  durationMs: number
): Promise<void> {
  if (!endpointId) {
    console.log("[webhook] no endpointId — skipping delivery record");
    return;
  }

  try {
    await db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_type, attempt, status_code, success, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [endpointId, eventType, attempt, statusCode, success, durationMs]
    );
  } catch (err) {
    // Log but don't fail the delivery itself if recording fails
    console.error("[webhook] failed to record delivery attempt:", err);
  }
}

async function deliverWebhook(job: WebhookJob, attempt: number): Promise<void> {
  const body = JSON.stringify(job.payload);
  const signature = signPayload(body, job.secret);
  const timestamp = Date.now();

  console.log(`[webhook] delivering ${job.eventType} to ${job.url} tenant=${job.tenantId}`);

  const startTime = Date.now();
  let statusCode: number | null = null;

  try {
    const response = await fetch(job.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GrainGuard-Signature": signature,
        "X-GrainGuard-Timestamp": String(timestamp),
        "X-GrainGuard-Event": job.eventType,
        "User-Agent": "GrainGuard-Webhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    const durationMs = Date.now() - startTime;
    statusCode = response.status;

    if (!response.ok) {
      await recordDelivery(job.endpointId, job.eventType, attempt + 1, statusCode, false, durationMs);
      throw new Error(`Webhook delivery failed: HTTP ${response.status} from ${job.url}`);
    }

    await recordDelivery(job.endpointId, job.eventType, attempt + 1, statusCode, true, durationMs);
    console.log(`[webhook] delivered successfully to ${job.url} status=${response.status}`);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    // Only record if we haven't already recorded above (i.e. non-HTTP errors like timeouts)
    if (statusCode === null) {
      await recordDelivery(job.endpointId, job.eventType, attempt + 1, null, false, durationMs);
    }
    throw err;
  }
}

export function startWebhookWorker(channel: Channel): void {
  channel.consume(QUEUES.WEBHOOKS, async (msg) => {
    if (!msg) return;

    let job: WebhookJob;

    try {
      job = JSON.parse(msg.content.toString()) as WebhookJob;
    } catch {
      console.error("[webhook] malformed message — sending to DLQ");
      channel.nack(msg, false, false);
      return;
    }

    const attempt = (msg.properties.headers?.["x-retry-count"] as number) || 0;
    const scheduledRetryAt = msg.properties.headers?.["x-scheduled-retry-at"] as string | undefined;

    // Idempotency: deduplicate by messageId to prevent double delivery
    const messageId = msg.properties.messageId || msg.fields.deliveryTag.toString();
    if (job.endpointId) {
      try {
        const { rowCount } = await db.query(
          `SELECT 1 FROM webhook_deliveries WHERE endpoint_id = $1 AND event_type = $2 AND success = true LIMIT 1`,
          [job.endpointId, job.eventType]
        );
        if (rowCount && rowCount > 0 && attempt === 0) {
          console.log(`[webhook] dedup: already delivered ${job.eventType} to endpoint=${job.endpointId}`);
          channel.ack(msg);
          return;
        }
      } catch {
        // Best-effort dedup — proceed if check fails
      }
    }

    // If this is a retry, check if we should wait longer before attempting
    if (attempt > 0 && scheduledRetryAt) {
      const retryTime = parseInt(scheduledRetryAt, 10);
      const now = Date.now();
      if (now < retryTime) {
        const waitMs = retryTime - now;
        console.log(`[webhook] delaying retry for ${Math.round(waitMs)}ms`);
        // Re-queue and wait for the delay
        channel.nack(msg, false, true); // requeue
        return;
      }
    }

    try {
      await deliverWebhook(job, attempt);
      channel.ack(msg);
    } catch (err) {
      console.error(`[webhook] failed attempt ${attempt + 1}/${MAX_RETRIES}:`, err);

      if (attempt >= MAX_RETRIES - 1) {
        console.error(`[webhook] max retries exceeded for ${job.url} — routing to DLQ`);
        channel.nack(msg, false, false);
      } else {
        // Avoid race condition: send to queue immediately with retry count incremented
        // This ensures the message is queued before this consumer dies
        const delay = retryDelay(attempt);
        console.log(`[webhook] scheduling retry in ${Math.round(delay)}ms`);

        // Re-queue immediately with x-retry-count header
        // RabbitMQ will deliver it to another consumer right away,
        // but the consumer can check the retry count and implement its own delay if needed
        channel.sendToQueue(
          QUEUES.WEBHOOKS,
          msg.content,
          {
            persistent: true,
            headers: {
              "x-retry-count": attempt + 1,
              "x-original-url": job.url,
              "x-scheduled-retry-at": String(Date.now() + delay),
            },
          }
        );
        channel.ack(msg); // Ack original message since we've safely re-queued it
      }
    }
  });

  console.log(`[webhook] worker listening on ${QUEUES.WEBHOOKS}`);
}
