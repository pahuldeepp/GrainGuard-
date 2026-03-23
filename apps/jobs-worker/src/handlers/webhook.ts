import { Channel } from "amqplib";
import { createHmac } from "crypto";
import { QUEUES, WebhookJob } from "../queues";
import { db } from "../db";

const MAX_RETRIES = 5;

// Sign payload with HMAC-SHA256
// Customer verifies: HMAC(secret, payload) === X-GrainGuard-Signature header
function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// Jittered backoff
function retryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  return Math.min(Math.random() * base + base, 60000); // cap at 60s
}

/**
 * Record a delivery attempt in the webhook_deliveries table.
 * Best-effort — failures are logged but don't affect the delivery flow.
 */
async function recordDelivery(
  endpointId: string | undefined,
  eventType: string,
  attempt: number,
  statusCode: number,
  success: boolean,
  durationMs: number
): Promise<void> {
  if (!endpointId) return;
  try {
    await db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_type, attempt, status_code, success, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [endpointId, eventType, attempt + 1, statusCode, success, durationMs]
    );
  } catch (err) {
    console.error("[webhook] failed to record delivery:", err);
  }
}

/**
 * Update the webhook_endpoints row with the last error (if any),
 * so the UI can show delivery health.
 */
async function updateEndpointStatus(
  endpointId: string | undefined,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  if (!endpointId) return;
  try {
    if (success) {
      await db.query(
        `UPDATE webhook_endpoints SET last_error = NULL, last_error_at = NULL WHERE id = $1`,
        [endpointId]
      );
    } else {
      await db.query(
        `UPDATE webhook_endpoints SET last_error = $1, last_error_at = NOW() WHERE id = $2`,
        [errorMessage?.slice(0, 500) ?? "Unknown error", endpointId]
      );
    }
  } catch (err) {
    console.error("[webhook] failed to update endpoint status:", err);
  }
}

async function deliverWebhook(
  job: WebhookJob,
  attempt: number
): Promise<{ statusCode: number; durationMs: number }> {
  const body = JSON.stringify(job.payload);
  const timestamp = Date.now();
  const signature = signPayload(body, job.secret);

  console.log(
    `[webhook] delivering ${job.eventType} to ${job.url} tenant=${job.tenantId} attempt=${attempt + 1}`
  );

  const start = Date.now();

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

  const durationMs = Date.now() - start;

  if (!response.ok) {
    throw Object.assign(
      new Error(
        `Webhook delivery failed: HTTP ${response.status} from ${job.url}`
      ),
      { statusCode: response.status, durationMs }
    );
  }

  console.log(
    `[webhook] delivered successfully to ${job.url} status=${response.status} duration=${durationMs}ms`
  );

  return { statusCode: response.status, durationMs };
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

    const attempt =
      (msg.properties.headers?.["x-retry-count"] as number) || 0;

    try {
      const { statusCode, durationMs } = await deliverWebhook(job, attempt);

      // Record successful delivery
      await recordDelivery(
        job.endpointId,
        job.eventType,
        attempt,
        statusCode,
        true,
        durationMs
      );
      await updateEndpointStatus(job.endpointId, true);

      channel.ack(msg);
    } catch (err: any) {
      const statusCode = err.statusCode ?? 0;
      const durationMs = err.durationMs ?? 0;

      console.error(
        `[webhook] failed attempt ${attempt + 1}/${MAX_RETRIES}:`,
        err.message || err
      );

      // Record failed delivery
      await recordDelivery(
        job.endpointId,
        job.eventType,
        attempt,
        statusCode,
        false,
        durationMs
      );

      if (attempt >= MAX_RETRIES - 1) {
        console.error(
          `[webhook] max retries exceeded for ${job.url} — routing to DLQ`
        );
        await updateEndpointStatus(
          job.endpointId,
          false,
          err.message || "Max retries exceeded"
        );
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        console.log(`[webhook] retrying in ${Math.round(delay)}ms`);

        setTimeout(() => {
          channel.nack(msg, false, false);
          channel.sendToQueue(QUEUES.WEBHOOKS, msg.content, {
            persistent: true,
            headers: {
              "x-retry-count": attempt + 1,
              "x-original-url": job.url,
            },
          });
        }, delay);
      }
    }
  });

  console.log(`[webhook] worker listening on ${QUEUES.WEBHOOKS}`);
}
