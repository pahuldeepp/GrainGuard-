import "dotenv/config";
import { connect, disconnect } from "./connection";
import { startEmailWorker } from "./handlers/email";
import { startWebhookWorker } from "./handlers/webhook";
import { startExportWorker } from "./handlers/export";
import { startAlertWorker } from "./handlers/alert";
import { startDigestScheduler } from "./handlers/digest";
import { startStripeWorker } from "./handlers/stripe";
import { db } from "./db";

async function main() {
  console.log("[jobs-worker] starting...");

  const channel = await connect();

  // Start all workers — each subscribes to its own queue
  startEmailWorker(channel);
  startWebhookWorker(channel);
  startExportWorker(channel);
  startAlertWorker(channel);
  startDigestScheduler(channel);
  startStripeWorker(channel);

  console.log("[jobs-worker] all workers running");

  let shuttingDown = false;

  async function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[jobs-worker] ${signal} received — shutting down gracefully`);

    // 1. Stop consuming new messages (cancel all consumers)
    try {
      await channel.close();
      console.log("[jobs-worker] channel closed — no new messages");
    } catch {
      // Channel may already be closed
    }

    // 2. Wait for in-flight messages to finish (give them 10s)
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    // 3. Close DB pool
    try {
      await db.end();
      console.log("[jobs-worker] DB pool closed");
    } catch {
      // Ignore
    }

    // 4. Disconnect from RabbitMQ
    await disconnect();

    console.log("[jobs-worker] shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[jobs-worker] fatal error:", err);
  process.exit(1);
});
