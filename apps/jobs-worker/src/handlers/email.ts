import { Channel } from "amqplib";
import axios from "axios";
import { QUEUES, EmailJob } from "../queues";

const MAX_RETRIES = 3;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM     = process.env.EMAIL_FROM || "GrainGuard <noreply@grainguard.com>";

// ── Simple circuit breaker for Resend API ────────────────────────────────
const circuitBreaker = {
  failures: 0,
  lastFailure: 0,
  threshold: 5,           // Open circuit after 5 consecutive failures
  resetTimeMs: 60_000,    // Try again after 60s

  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    // If enough time has passed, allow a retry (half-open)
    if (Date.now() - this.lastFailure > this.resetTimeMs) {
      return false;
    }
    return true;
  },

  recordSuccess() {
    this.failures = 0;
  },

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
  },
};

/**
 * Send an email via the Resend API (https://resend.com).
 * Set RESEND_API_KEY in the environment to enable real sending.
 * Without it the call is skipped and only logged — safe for local dev.
 */
async function sendEmail(job: EmailJob): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn(
      `[email] RESEND_API_KEY not set — skipping real send. ` +
      `type=${job.type} to=${job.to} tenant=${job.tenantId}`
    );
    return;
  }

  if (circuitBreaker.isOpen()) {
    throw new Error("Circuit breaker open — Resend API has too many failures");
  }

  try {
    const response = await axios.post(
      "https://api.resend.com/emails",
      {
        from:    EMAIL_FROM,
        to:      [job.to],
        subject: job.subject,
        html:    job.body,
      },
      {
        headers: {
          Authorization:  `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );

    circuitBreaker.recordSuccess();

    console.log(
      `[email] sent type=${job.type} to=${job.to} id=${response.data?.id} tenant=${job.tenantId}`
    );
  } catch (err) {
    circuitBreaker.recordFailure();
    throw err;
  }
}

// Jittered backoff for retries — cap at 5 minutes
function retryDelay(attempt: number): number {
  const base   = 1000 * Math.pow(2, attempt); // exponential
  const jitter = Math.random() * base;         // full jitter
  return Math.min(base + jitter, 300_000);     // cap at 5 min
}

export function startEmailWorker(channel: Channel): void {
  channel.consume(QUEUES.EMAILS, async (msg) => {
    if (!msg) return;

    let job: EmailJob;

    try {
      job = JSON.parse(msg.content.toString()) as EmailJob;
    } catch {
      console.error("[email] malformed message — sending to DLQ");
      channel.nack(msg, false, false);
      return;
    }

    const attempt = (msg.properties.headers?.["x-retry-count"] as number) || 0;

    try {
      await sendEmail(job);
      channel.ack(msg);
    } catch (err) {
      console.error(`[email] failed attempt ${attempt + 1}/${MAX_RETRIES}:`, err);

      if (attempt >= MAX_RETRIES - 1) {
        console.error(`[email] max retries exceeded for ${job.to} — routing to DLQ`);
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        console.log(`[email] retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);

        setTimeout(() => {
          channel.nack(msg, false, false);
          channel.sendToQueue(
            QUEUES.EMAILS,
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

  console.log(`[email] worker listening on ${QUEUES.EMAILS}`);
}
