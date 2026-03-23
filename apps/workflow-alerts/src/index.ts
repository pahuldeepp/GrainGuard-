import { Kafka } from "kafkajs";
import amqp, { Channel, ChannelModel } from "amqplib";

const KAFKA_BROKERS  = (process.env.KAFKA_BROKERS || "kafka:9092").split(",");
const RISK_TOPIC     = process.env.RISK_SCORES_TOPIC || "risk.scores";
const GROUP_ID       = process.env.KAFKA_GROUP_ID || "workflow-alerts";
const RABBITMQ_URL   = process.env.RABBITMQ_URL || "amqp://grainguard:grainguard@rabbitmq:5672/grainguard";
const ALERT_QUEUE    = "grainguard.alerts";
const ALERT_DLQ      = "grainguard.alerts.dlq";

// Dedupe cooldown — don't re-alert same device within 5 minutes
const COOLDOWN_MS = 5 * 60 * 1000;
const cooldowns = new Map<string, number>();

// Sweep expired entries every 10 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of cooldowns) {
    if (now - ts >= COOLDOWN_MS) cooldowns.delete(key);
  }
}, 10 * 60 * 1000).unref();

function isOnCooldown(deviceId: string, tenantId: string): boolean {
  const key = `${tenantId}:${deviceId}`;
  const last = cooldowns.get(key);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(deviceId: string, tenantId: string): void {
  cooldowns.set(`${tenantId}:${deviceId}`, Date.now());
}

async function connectRabbitMQ(retries = 10, delay = 3000): Promise<{ conn: ChannelModel; ch: Channel }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      const ch   = await conn.createChannel();

      // Assert queues consistent with jobs-worker
      await ch.assertQueue(ALERT_QUEUE, { durable: true, arguments: { "x-dead-letter-exchange": "", "x-dead-letter-routing-key": ALERT_DLQ } });
      await ch.assertQueue(ALERT_DLQ,   { durable: true });

      console.log("[rabbitmq] connected");
      return { conn, ch };
    } catch (err) {
      console.warn(`[rabbitmq] attempt ${attempt}/${retries} failed:`, err);
      await new Promise(r => setTimeout(r, delay));
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

  const kafka   = new Kafka({ brokers: KAFKA_BROKERS, clientId: "workflow-alerts" });
  const consumer = kafka.consumer({ groupId: GROUP_ID });

  await consumer.connect();
  await consumer.subscribe({ topic: RISK_TOPIC, fromBeginning: false });

  console.log(`[workflow-alerts] consuming topic=${RISK_TOPIC}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString());

        const deviceId  = event.device_id;
        const tenantId  = event.tenant_id || "unknown";
        const score     = event.score;
        const level     = event.level;
        const temperature = event.temperature;
        const humidity    = event.humidity;

        if (!deviceId || level === "safe") return;

        // Deduplicate — skip if device already alerted recently
        if (isOnCooldown(deviceId, tenantId)) {
          console.log(`[workflow-alerts] cooldown active device=${deviceId} — skipping`);
          return;
        }

        // Determine alert type and threshold
        const alertType  = temperature >= 35 ? "temperature" : "humidity";
        const value      = alertType === "temperature" ? temperature : humidity;
        const threshold  = alertType === "temperature" ? 35 : 80;

        const alertJob = {
          tenantId,
          deviceId,
          serialNumber: deviceId, // enriched by asset-registry later
          alertType,
          value,
          threshold,
          score,
          level,
          recipients:  [`alerts@tenant-${tenantId}.grainguard.io`],
          retryCount:  0,
        };

        await publishAlert(ch, alertJob);
        setCooldown(deviceId, tenantId);

        console.log(`[workflow-alerts] alert queued device=${deviceId} level=${level} score=${score}`);
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
