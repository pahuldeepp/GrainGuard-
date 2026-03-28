import { Kafka } from "kafkajs";
import amqp, { Channel, ChannelModel } from "amqplib";
import { Pool } from "pg";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || "kafka:9092").split(",");
const RISK_TOPIC = process.env.RISK_SCORES_TOPIC || "risk.scores";
const GROUP_ID = process.env.KAFKA_GROUP_ID || "workflow-alerts";
const RABBITMQ_URL =
  process.env.RABBITMQ_URL ||
  "amqp://grainguard:grainguard@rabbitmq:5672/grainguard";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.WRITE_DB_URL ||
  "postgresql://postgres:postgres@postgres:5432/grainguard";
const ALERT_QUEUE = "grainguard.alerts";
const ALERT_DLQ = "grainguard.alerts.dlq";

interface RiskScoreEvent {
  device_id?: string;
  tenant_id?: string;
  score?: number;
  level?: string;
  temperature?: number | null;
  humidity?: number | null;
  t_score?: number;
  h_score?: number;
  t_threshold?: number | null;
  h_threshold?: number | null;
  recipients?: string[];
  source_event_id?: string | null;
}

const db = new Pool({ connectionString: DATABASE_URL, max: 5 });

const COOLDOWN_MS = 5 * 60 * 1000;
const PROCESSED_EVENT_TTL_MS = 30 * 60 * 1000;
const cooldowns = new Map<string, number>();
const processedEvents = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of cooldowns) {
    if (now - timestamp >= COOLDOWN_MS) {
      cooldowns.delete(key);
    }
  }
  for (const [key, timestamp] of processedEvents) {
    if (now - timestamp >= PROCESSED_EVENT_TTL_MS) {
      processedEvents.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

async function resolveSerialNumber(deviceId: string): Promise<string> {
  try {
    const { rows } = await db.query(
      `SELECT serial_number FROM devices WHERE id = $1 LIMIT 1`,
      [deviceId],
    );
    return rows[0]?.serial_number ?? deviceId;
  } catch {
    return deviceId;
  }
}

function isOnCooldown(deviceId: string, tenantId: string): boolean {
  const key = `${tenantId}:${deviceId}`;
  const last = cooldowns.get(key);
  return !!last && Date.now() - last < COOLDOWN_MS;
}

function setCooldown(deviceId: string, tenantId: string): void {
  cooldowns.set(`${tenantId}:${deviceId}`, Date.now());
}

function markProcessed(eventKey: string): void {
  processedEvents.set(eventKey, Date.now());
}

function hasProcessed(eventKey: string): boolean {
  const timestamp = processedEvents.get(eventKey);
  return !!timestamp && Date.now() - timestamp < PROCESSED_EVENT_TTL_MS;
}

async function connectRabbitMQ(
  retries = 10,
  delay = 3000,
): Promise<{ conn: ChannelModel; ch: Channel }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      const ch = await conn.createChannel();

      await ch.assertQueue(ALERT_QUEUE, {
        durable: true,
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
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Could not connect to RabbitMQ");
}

function publishAlert(ch: Channel, job: object): void {
  ch.sendToQueue(ALERT_QUEUE, Buffer.from(JSON.stringify(job)), {
    persistent: true,
    contentType: "application/json",
  });
}

function normalizeRiskEvent(event: unknown): RiskScoreEvent | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const candidate = event as RiskScoreEvent;
  if (!candidate.device_id || !candidate.tenant_id || !candidate.level) {
    return null;
  }

  if (candidate.level === "safe") {
    return null;
  }

  return {
    device_id: candidate.device_id,
    tenant_id: candidate.tenant_id,
    score: typeof candidate.score === "number" ? candidate.score : 0,
    level: candidate.level,
    temperature:
      typeof candidate.temperature === "number" ? candidate.temperature : null,
    humidity: typeof candidate.humidity === "number" ? candidate.humidity : null,
    t_score: typeof candidate.t_score === "number" ? candidate.t_score : 0,
    h_score: typeof candidate.h_score === "number" ? candidate.h_score : 0,
    t_threshold:
      typeof candidate.t_threshold === "number" ? candidate.t_threshold : null,
    h_threshold:
      typeof candidate.h_threshold === "number" ? candidate.h_threshold : null,
    recipients: Array.isArray(candidate.recipients)
      ? candidate.recipients.filter(
          (recipient): recipient is string =>
            typeof recipient === "string" && recipient.length > 0,
        )
      : [],
    source_event_id:
      typeof candidate.source_event_id === "string"
        ? candidate.source_event_id
        : null,
  };
}

function inferAlertType(event: RiskScoreEvent): {
  alertType: "temperature" | "humidity";
  value: number | null;
  threshold: number | null;
} {
  const preferTemperature =
    (event.t_score ?? 0) >= (event.h_score ?? 0) && event.temperature != null;
  if (preferTemperature || event.humidity == null) {
    return {
      alertType: "temperature",
      value: event.temperature ?? null,
      threshold: event.t_threshold ?? null,
    };
  }

  return {
    alertType: "humidity",
    value: event.humidity ?? null,
    threshold: event.h_threshold ?? null,
  };
}

async function main() {
  console.log("[workflow-alerts] starting");

  let { ch } = await connectRabbitMQ();

  const kafka = new Kafka({
    brokers: KAFKA_BROKERS,
    clientId: "workflow-alerts",
  });
  const consumer = kafka.consumer({ groupId: GROUP_ID });

  await consumer.connect();
  await consumer.subscribe({ topic: RISK_TOPIC, fromBeginning: false });

  console.log(`[workflow-alerts] consuming topic=${RISK_TOPIC}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        if (!message.value) {
          return;
        }

        const parsed = JSON.parse(message.value.toString());
        const event = normalizeRiskEvent(parsed);
        if (!event) {
          return;
        }

        const deviceId = event.device_id!;
        const tenantId = event.tenant_id!;
        const level = event.level!;
        const eventKey =
          event.source_event_id != null
            ? `${event.source_event_id}:${level}`
            : `${tenantId}:${deviceId}:${level}`;

        if (hasProcessed(eventKey)) {
          console.log(`[workflow-alerts] duplicate event ${eventKey} — skipping`);
          return;
        }

        if (isOnCooldown(deviceId, tenantId)) {
          console.log(
            `[workflow-alerts] cooldown active device=${deviceId} — skipping`,
          );
          return;
        }

        const { alertType, value, threshold } = inferAlertType(event);
        const serialNumber = await resolveSerialNumber(deviceId);

        const alertJob = {
          tenantId,
          deviceId,
          serialNumber,
          alertType,
          value,
          threshold,
          score: event.score ?? 0,
          level,
          recipients: event.recipients ?? [],
          retryCount: 0,
        };

        try {
          publishAlert(ch, alertJob);
        } catch (err) {
          console.error(
            "[workflow-alerts] RabbitMQ publish failed, reconnecting:",
            err,
          );
          ({ ch } = await connectRabbitMQ(3, 1000));
          publishAlert(ch, alertJob);
        }

        setCooldown(deviceId, tenantId);
        markProcessed(eventKey);

        console.log(
          `[workflow-alerts] alert queued device=${deviceId} serial=${serialNumber} ` +
            `level=${level} score=${event.score ?? 0} recipients=${(event.recipients ?? []).length}`,
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
