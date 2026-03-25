import { Channel } from "amqplib";
import sgMail from "@sendgrid/mail";
import { QUEUES, EmailJob } from "../queues";

const MAX_RETRIES = 3;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "alerts@grainguard.io";
const FROM_NAME = process.env.SENDGRID_FROM_NAME || "GrainGuard";

// Initialize SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log("[email] SendGrid initialized");
} else {
  console.warn("[email] SENDGRID_API_KEY not set — emails will be logged only");
}

// HTML templates per email type
const templates: Record<EmailJob["type"], (job: EmailJob) => string> = {
  alert: (job) => `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #dc2626; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">⚠️ GrainGuard Alert</h2>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        ${job.body.replace(/\n/g, "<br>")}
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
        <p style="color: #6b7280; font-size: 12px;">
          Tenant: ${job.tenantId} · 
          <a href="https://app.grainguard.io/alerts">View in Dashboard</a>
        </p>
      </div>
    </div>
  `,

  welcome: (job) => `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #059669; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">Welcome to GrainGuard 🌾</h2>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        ${job.body.replace(/\n/g, "<br>")}
        <p><a href="https://app.grainguard.io" style="background: #059669; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">Get Started</a></p>
      </div>
    </div>
  `,

  usage_warning: (job) => `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #d97706; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">📊 Usage Warning</h2>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        ${job.body.replace(/\n/g, "<br>")}
        <p><a href="https://app.grainguard.io/billing">Manage Plan</a></p>
      </div>
    </div>
  `,

  invoice: (job) => `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #2563eb; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">💳 Invoice</h2>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        ${job.body.replace(/\n/g, "<br>")}
        <p><a href="https://app.grainguard.io/billing">View Billing</a></p>
      </div>
    </div>
  `,
};

async function sendEmail(job: EmailJob): Promise<void> {
  const html = templates[job.type]?.(job) ?? job.body;

  if (!SENDGRID_API_KEY) {
    // Dev/test mode — log instead of sending
    console.log(`[email] DEV MODE — would send ${job.type} email to ${job.to}`);
    console.log(`[email]   subject: ${job.subject}`);
    return;
  }

  await sgMail.send({
    to: job.to,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: job.subject,
    html,
    mailSettings: {
      sandboxMode: { enable: process.env.SENDGRID_SANDBOX === "true" },
    },
    trackingSettings: {
      clickTracking: { enable: true },
      openTracking: { enable: true },
    },
    customArgs: {
      tenantId: job.tenantId,
      emailType: job.type,
    },
  });

  console.log(`[email] sent ${job.type} email to ${job.to} tenant=${job.tenantId}`);
}

// Jittered backoff for retries
function retryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = Math.random() * base;
  return Math.min(base + jitter, 30000);
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
    } catch (err: unknown) {
      const status = (err as { code?: number }).code;
      console.error(`[email] failed attempt ${attempt + 1}/${MAX_RETRIES} (status=${status}):`, err);

      // Don't retry 4xx errors (bad request, invalid email, etc.) — they won't succeed
      if (status && status >= 400 && status < 500) {
        console.error(`[email] permanent failure (${status}) for ${job.to} — routing to DLQ`);
        channel.nack(msg, false, false);
        return;
      }

      if (attempt >= MAX_RETRIES - 1) {
        console.error(`[email] max retries exceeded for ${job.to} — routing to DLQ`);
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        console.log(`[email] retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);
        // Re-queue immediately with incremented retry count, then ack original
        channel.sendToQueue(QUEUES.EMAILS, msg.content, {
          persistent: true,
          headers: {
            "x-retry-count": attempt + 1,
            "x-scheduled-retry-at": Date.now() + delay,
          },
        });
        channel.ack(msg);
      }
    }
  });

  console.log(`[email] worker listening on ${QUEUES.EMAILS}`);
}
