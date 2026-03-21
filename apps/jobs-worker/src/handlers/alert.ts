import { Channel } from "amqplib";
import { QUEUES, AlertJob, EmailJob } from "../queues";

const MAX_RETRIES = 3;

function retryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  return Math.min(Math.random() * base + base, 30000);
}

async function processAlert(job: AlertJob, channel: Channel): Promise<void> {
  console.log(`[alert] ${job.alertType} alert device=${job.serialNumber} value=${job.value} threshold=${job.threshold} tenant=${job.tenantId}`);

  // Fan out to all recipients via email queue
  for (const recipient of job.recipients) {
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
  }

  console.log(`[alert] processed — notified ${job.recipients.length} recipients`);
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

