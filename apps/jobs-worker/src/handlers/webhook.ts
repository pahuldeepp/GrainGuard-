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

    try {
      await deliverWebhook(job, attempt);
      channel.ack(msg);
    } catch (err) {
      console.error(`[webhook] failed attempt ${attempt + 1}/${MAX_RETRIES}:`, err);

      if (attempt >= MAX_RETRIES - 1) {
        console.error(`[webhook] max retries exceeded for ${job.url} — routing to DLQ`);
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        console.log(`[webhook] retrying in ${Math.round(delay)}ms`);

        setTimeout(() => {
          channel.nack(msg, false, false);
          channel.sendToQueue(
            QUEUES.WEBHOOKS,
            msg.content,
            {
              persistent: true,
              headers: {
                "x-retry-count": attempt + 1,
                "x-original-url": job.url,
              },
            }
          );
        }, delay);
      }
    }
  });

  console.log(`[webhook] worker listening on ${QUEUES.WEBHOOKS}`);
}
