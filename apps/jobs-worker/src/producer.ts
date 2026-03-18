import amqp from "amqplib";
import { QUEUES, EmailJob, WebhookJob, ExportJob, AlertJob } from "./queues";

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://grainguard:grainguard@rabbitmq:5672/grainguard";

async function getChannel() {
  const conn = await amqp.connect(RABBITMQ_URL);
  return conn.createChannel();
}

export async function publishEmailJob(job: EmailJob): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(QUEUES.EMAILS, Buffer.from(JSON.stringify(job)), { persistent: true });
  console.log("[producer] email job queued to=" + job.to);
  await ch.close();
}

export async function publishWebhookJob(job: WebhookJob): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(QUEUES.WEBHOOKS, Buffer.from(JSON.stringify(job)), { persistent: true });
  console.log("[producer] webhook job queued url=" + job.url);
  await ch.close();
}

export async function publishExportJob(job: ExportJob): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(QUEUES.EXPORTS, Buffer.from(JSON.stringify(job)), { persistent: true });
  console.log("[producer] export job queued tenant=" + job.tenantId);
  await ch.close();
}

export async function publishAlertJob(job: AlertJob): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(QUEUES.ALERTS, Buffer.from(JSON.stringify(job)), { persistent: true });
  console.log("[producer] alert job queued device=" + job.deviceId);
  await ch.close();
}
