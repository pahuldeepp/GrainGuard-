// review-sweep
import { Channel } from "amqplib";
import { QUEUES, EmailJob } from "../queues";

const MAX_RETRIES = 3;

// Simulate email sending (replace with SendGrid in Phase 6)
async function sendEmail(job: EmailJob): Promise<void> {
  // TODO Phase 6: replace with SendGrid
  // const sgMail = require("@sendgrid/mail");
  // sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  // await sgMail.send({ to: job.to, subject: job.subject, html: job.body });
  
  console.log(`[email] sending ${job.type} email to ${job.to} tenant=${job.tenantId}`);
  
  // Simulate network latency
  await new Promise((r) => setTimeout(r, 100));
  
  console.log(`[email] sent successfully to ${job.to}`);
}

// Jittered backoff for retries
function retryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);     // exponential
  const jitter = Math.random() * base;           // full jitter
  return Math.min(base + jitter, 30000);         // cap at 30s
}

export function startEmailWorker(channel: Channel): void {
  channel.consume(QUEUES.EMAILS, async (msg) => {
    if (!msg) return;

    let job: EmailJob;
    
    try {
      job = JSON.parse(msg.content.toString()) as EmailJob;
    } catch {
      console.error("[email] malformed message — sending to DLQ");
      channel.nack(msg, false, false); // false, false = don't requeue
      return;
    }

    const attempt = (msg.properties.headers?.["x-retry-count"] as number) || 0;

    try {
      await sendEmail(job);
      channel.ack(msg);                          // success — remove from queue
    } catch (err) {
      console.error(`[email] failed attempt ${attempt + 1}/${MAX_RETRIES}:`, err);

      if (attempt >= MAX_RETRIES - 1) {
        // Max retries exceeded — send to DLQ
        console.error(`[email] max retries exceeded for ${job.to} — routing to DLQ`);
        channel.nack(msg, false, false);         // reject, no requeue → DLQ
      } else {
        // Retry with jittered backoff
        const delay = retryDelay(attempt);
        console.log(`[email] retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);
        
        setTimeout(() => {
          channel.nack(msg, false, false);       // nack → DLQ
          // Re-publish with incremented retry count
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
