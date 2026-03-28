import amqp from "amqplib";

const RABBITMQ_URL =
  process.env.RABBITMQ_URL ||
  "amqp://grainguard:grainguard@rabbitmq:5672/grainguard";

const EMAIL_QUEUE = "grainguard.emails";

export interface EmailJob {
  to: string;
  subject: string;
  body: string;
  tenantId: string;
  type: "welcome" | "alert" | "usage_warning" | "invoice" | "invite";
}

export async function publishEmailJob(job: EmailJob): Promise<void> {
  let conn: Awaited<ReturnType<typeof amqp.connect>> | null = null;
  let ch: amqp.ConfirmChannel | null = null;

  try {
    conn = await amqp.connect(RABBITMQ_URL);
    ch = await conn.createConfirmChannel();
    await ch.assertQueue(EMAIL_QUEUE, { durable: true });
    ch.sendToQueue(EMAIL_QUEUE, Buffer.from(JSON.stringify(job)), {
      persistent: true,
    });
    await ch.waitForConfirms();
  } finally {
    await ch?.close().catch(() => {});
    conn?.close().catch(() => {});
  }
}
