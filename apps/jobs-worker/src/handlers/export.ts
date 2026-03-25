import { Channel } from "amqplib";
import axios from "axios";
import { Pool } from "pg";
import { QUEUES, ExportJob } from "../queues";

const MAX_RETRIES  = 3;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM     = process.env.EMAIL_FROM || "GrainGuard <noreply@grainguard.com>";

// Lazily initialised — only created when DATABASE_URL is present
let _pool: Pool | null = null;
function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

function retryDelay(attempt: number): number {
  const base = 2000 * Math.pow(2, attempt);
  return Math.min(Math.random() * base + base, 60000);
}

async function generateExport(job: ExportJob): Promise<void> {
  console.log(`[export] starting type=${job.exportType} tenant=${job.tenantId}`);

  const result: Record<string, unknown> = {
    exportType:  job.exportType,
    tenantId:    job.tenantId,
    generatedAt: new Date().toISOString(),
    filters:     job.filters,
    records:     [] as unknown[],
  };

  const pool = getPool();
  if (pool) {
    try {
      if (job.exportType === "devices") {
        const { rows } = await pool.query(
          `SELECT id, serial_number, created_at
           FROM devices
           WHERE tenant_id = $1
           ORDER BY created_at DESC`,
          [job.tenantId]
        );
        result.records = rows;
      } else if (job.exportType === "telemetry") {
        const { rows } = await pool.query(
          `SELECT d.serial_number, t.temperature, t.humidity, t.recorded_at
           FROM telemetry_readings t
           JOIN devices d ON d.id = t.device_id
           WHERE d.tenant_id = $1
           ORDER BY t.recorded_at DESC
           LIMIT 50000`,
          [job.tenantId]
        );
        result.records = rows;
      }
    } catch (err) {
      console.error("[export] DB query failed:", err);
      // Still deliver empty export rather than losing the job
    }
  } else {
    console.warn("[export] DATABASE_URL not set — export will have no records");
  }

  const records  = result.records as unknown[];
  const jsonStr  = JSON.stringify(result, null, 2);
  const filename = `grainguard-export-${job.exportType}-${Date.now()}.json`;

  if (RESEND_API_KEY) {
    await axios.post(
      "https://api.resend.com/emails",
      {
        from:    EMAIL_FROM,
        to:      [job.deliveryEmail],
        subject: `Your GrainGuard ${job.exportType} export is ready`,
        html: `
          <p>Hi,</p>
          <p>Your <strong>${job.exportType}</strong> data export is attached as a JSON file.</p>
          <ul>
            <li>Records exported: <strong>${records.length}</strong></li>
            <li>Generated: ${result.generatedAt}</li>
          </ul>
          <p>— The GrainGuard Team</p>
        `,
        attachments: [
          {
            filename,
            content: Buffer.from(jsonStr).toString("base64"),
          },
        ],
      },
      {
        headers: {
          Authorization:  `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      }
    );
    console.log(`[export] delivered ${filename} (${records.length} records) to ${job.deliveryEmail}`);
  } else {
    console.log(
      `[export] complete — RESEND_API_KEY not set, skipping email. ` +
      `tenant=${job.tenantId} type=${job.exportType} records=${records.length}`
    );
  }
}

export function startExportWorker(channel: Channel): void {
  channel.consume(QUEUES.EXPORTS, async (msg) => {
    if (!msg) return;

    let job: ExportJob;
    try {
      job = JSON.parse(msg.content.toString()) as ExportJob;
    } catch {
      channel.nack(msg, false, false);
      return;
    }

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
          channel.sendToQueue(QUEUES.EXPORTS, msg.content, {
            persistent: true,
            headers: { "x-retry-count": attempt + 1 },
          });
        }, delay);
      }
    }
  });

  console.log(`[export] worker listening on ${QUEUES.EXPORTS}`);
}
