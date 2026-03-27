import { Kafka } from "kafkajs";
import amqp, { Channel, ChannelModel } from "amqplib";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || "kafka:9092").split(",");
const RISK_TOPIC    = process.env.RISK_SCORES_TOPIC || "risk.scores";
const GROUP_ID      = process.env.KAFKA_GROUP_ID   || "workflow-alerts";
const RABBITMQ_URL  = process.env.RABBITMQ_URL     || "amqp://grainguard:grainguard@rabbitmq:5672/grainguard";
const ALERT_QUEUE   = "grainguard.alerts";
const ALERT_DLQ     = "grainguard.alerts.dlq";

// Dedupe cooldown — don't re-alert same device within 5 minutes
const COOLDOWN_MS = 5 * 60 * 1000;
const cooldowns   = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of cooldowns) {
    if (now - ts >= COOLDOWN_MS) cooldowns.delete(key);
  }
}, 10 * 60 * 1000).unref();

function isOnCooldown(deviceId: string, tenantId: string): boolean {
  const key  = `${tenantId}:${deviceId}`;
  const last = cooldowns.get(key);
  return !!last && Date.now() - last < COOLDOWN_MS;
}

function setCooldown(deviceId: string, tenantId: string): void {
  cooldowns.set(`${tenantId}:${deviceId}`, Date.now());
}

async function connectRabbitMQ(retries = 10, delay = 3000): Promise<{ conn: ChannelModel; ch: Channel }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      const ch   = await conn.createChannel();

      await ch.assertQueue(ALERT_QUEUE, {
        durable:   true,
        arguments: {
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": ALERT_DLQ,
          "x-message-ttl": 86400000,
        },
      });
      await ch.assertQueue(ALERT_DLQ, { durable: true });

      console.log("[rabbitmq] connected");
      return { conn, ch };
    } catch (err) {
      console.warn(`[rabbitmq] attempt ${attempt}/${retries} failed:`, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Could not connect to RabbitMQ");
}

async function publishAlert(ch: Channel, job: object): Promise<void> {
  ch.sendToQueue(
    ALERT_QUEUE,
    Buffer.from(JSON.stringify(job)),
    { persistent: true, contentType: "application/json" }
  );
}

async function main() {
  console.log("[workflow-alerts] starting");

  const { ch } = await connectRabbitMQ();

  const kafka    = new Kafka({ brokers: KAFKA_BROKERS, clientId: "workflow-alerts" });
  const consumer = kafka.consumer({ groupId: GROUP_ID });

  await consumer.connect();
  await consumer.subscribe({ topic: RISK_TOPIC, fromBeginning: false });

  console.log(`[workflow-alerts] consuming topic=${RISK_TOPIC}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString());

        const deviceId    = event.device_id   as string | undefined;
        const tenantId    = (event.tenant_id  as string | undefined) ?? "unknown";
        const score       = event.score       as number;
        const level       = event.level       as string;
        const temperature = event.temperature as number | null | undefined;
        const humidity    = event.humidity    as number | null | undefined;
        // Recipients are resolved by risk-engine from DB — use them directly
        const recipients  = Array.isArray(event.recipients) ? event.recipients as string[] : [];

        if (!deviceId || level === "safe") return;

        if (isOnCooldown(deviceId, tenantId)) {
          console.log(`[workflow-alerts] cooldown active device=${deviceId} — skipping`);
          return;
        }

        // Determine dominant alert type from whichever reading is higher relative to normal
        const alertType =
          temperature != null
            ? "temperature"
            : "humidity";

        const value     = alertType === "temperature" ? temperature : humidity;

        const alertJob = {
          tenantId,
          deviceId,
          serialNumber: deviceId, // enriched by asset-registry downstream
          alertType,
          value,
          score,
          level,
          recipients,            // real emails, not fabricated addresses
          retryCount: 0,
        };

        await publishAlert(ch, alertJob);
        setCooldown(deviceId, tenantId);

        console.log(
          `[workflow-alerts] alert queued device=${deviceId} level=${level} score=${score} recipients=${recipients.length}`
        );
      } catch (err) {
        console.error("[workflow-alerts] error processing message:", err);
      }
    },
  });
}

main().catch((err) => {
  console.error("[workflow-alerts] fatal:", err);
  process.exit(1);
});
