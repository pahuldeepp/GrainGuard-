// review-sweep
import { Channel } from "amqplib";
import { QUEUES, ExportJob } from "../queues";

const MAX_RETRIES = 3;

function retryDelay(attempt: number): number {
  const base = 2000 * Math.pow(2, attempt);
  return Math.min(Math.random() * base + base, 60000);
}

async function generateExport(job: ExportJob): Promise<void> {
  console.log("[export] starting " + job.exportType + " export tenant=" + job.tenantId);
  await new Promise((r) => setTimeout(r, 500));
  console.log("[export] complete — would email link to " + job.deliveryEmail);
}

export function startExportWorker(channel: Channel): void {
  channel.consume(QUEUES.EXPORTS, async (msg) => {
    if (!msg) return;
    let job: ExportJob;
    try { job = JSON.parse(msg.content.toString()) as ExportJob; }
    catch { channel.nack(msg, false, false); return; }
    const attempt = (msg.properties.headers?.["x-retry-count"] as number) || 0;
    try {
      await generateExport(job);
      channel.ack(msg);
    } catch (err) {
      console.error("[export] failed:", err);
      if (attempt >= MAX_RETRIES - 1) {
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        setTimeout(() => {
          channel.nack(msg, false, false);
          channel.sendToQueue(QUEUES.EXPORTS, msg.content, { persistent: true, headers: { "x-retry-count": attempt + 1 } });
        }, delay);
      }
    }
  });
  console.log("[export] worker listening on " + QUEUES.EXPORTS);
}
