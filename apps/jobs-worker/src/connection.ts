import { connect as amqpConnect } from "amqplib";
import { QUEUES, DLQ } from "./queues";

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://grainguard:grainguard@rabbitmq:5672/grainguard";

let conn: Awaited<ReturnType<typeof amqpConnect>> | null = null;
let ch: any = null;

function jitteredDelay(attempt: number, baseMs = 1000, maxMs = 30000): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  return Math.floor(Math.random() * exponential);
}

export async function connect(): Promise<any> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      console.log("[rabbitmq] connecting attempt " + attempt + "/10...");
      conn = await amqpConnect(RABBITMQ_URL);
      ch = await conn.createChannel();
      await ch.prefetch(1);

      for (const [key, queue] of Object.entries(QUEUES)) {
        const dlq = DLQ[key as keyof typeof DLQ];
        await ch.assertQueue(dlq, { durable: true });
        await ch.assertQueue(queue, {
          durable: true,
          arguments: {
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": dlq,
            "x-message-ttl": 86400000,
          },
        });
        console.log("[rabbitmq] queue ready: " + queue + " -> dlq: " + dlq);
      }

      console.log("[rabbitmq] connected and all queues ready");
      return ch;
    } catch (err) {
      console.error("[rabbitmq] attempt " + attempt + " failed:", err);
      if (attempt < 10) {
        const delay = jitteredDelay(attempt);
        console.log("[rabbitmq] retrying in " + delay + "ms");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error("Could not connect to RabbitMQ after 10 attempts");
}

export function getChannel(): any {
  if (!ch) throw new Error("RabbitMQ channel not initialized");
  return ch;
}

export async function disconnect(): Promise<void> {
  try {
    await ch?.close();
    await conn?.close();
    console.log("[rabbitmq] disconnected");
  } catch (err) {
    console.error("[rabbitmq] disconnect error:", err);
  }
}

