import "dotenv/config";
import { connect, disconnect } from "./connection";
import { startEmailWorker } from "./handlers/email";
import { startWebhookWorker } from "./handlers/webhook";
import { startExportWorker } from "./handlers/export";
import { startAlertWorker } from "./handlers/alert";

async function main() {
  console.log("[jobs-worker] starting...");

  const channel = await connect();

  // Start all workers — each subscribes to its own queue
  startEmailWorker(channel);
  startWebhookWorker(channel);
  startExportWorker(channel);
  startAlertWorker(channel);

  console.log("[jobs-worker] all workers running");

  // Graceful shutdown — K8s sends SIGTERM before killing pod
  // Wait for in-flight messages to finish before disconnecting
  process.on("SIGTERM", async () => {
    console.log("[jobs-worker] SIGTERM received — shutting down gracefully");
    await disconnect();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("[jobs-worker] SIGINT received — shutting down");
    await disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[jobs-worker] fatal error:", err);
  process.exit(1);
});

