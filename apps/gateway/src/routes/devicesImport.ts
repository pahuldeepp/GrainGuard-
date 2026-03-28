import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { bulkRateLimiter } from "../middleware/rateLimiting";
import { writePool as pool } from "../database/db";
import { createDevice } from "../services/device";
import Busboy from "busboy";

export const devicesImportRouter = Router();

// ── POST /devices/bulk ────────────────────────────────────────────────────────
// Accepts a multipart CSV upload. Each row is a serial number.
// Processing is synchronous per-row but streamed — the response is an SSE
// stream so the frontend can show a live progress bar.
//
// CSV format (header required):
//   serialNumber
//   SN00100001
//   SN00100002
//   ...
//
// The response is text/event-stream.  Each event is:
//   data: {"total":N,"done":N,"errors":N,"current":"SN...","status":"ok"|"error","message":"..."}
//
// A final event has done === total.
devicesImportRouter.post(
  "/devices/bulk",
  bulkRateLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    // Verify admin or member role — viewers cannot register devices
    const roles = req.user!.roles ?? [];
    if (!roles.includes("admin") && !roles.includes("member")) {
      return res.status(403).json({ error: "forbidden" });
    }

    const tenantId = req.user!.tenantId;
    const userId   = req.user!.sub;

    // Content-Type must be multipart/form-data
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return res.status(400).json({ error: "must_be_multipart" });
    }

    // Switch to SSE so the browser gets live progress
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no", // nginx: don't buffer SSE
    });

    // Helper to push an SSE event
    function emit(data: object) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    // Parse the multipart body
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB max

    // Collect CSV lines from the file field
    const lines: string[] = [];
    let headerSeen = false;
    let serialColIndex = 0; // which CSV column holds serialNumber

    bb.on("file", (_fieldname: string, file: NodeJS.ReadableStream) => {
      let buffer = "";

      (file as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split("\n");
        // Everything except the last incomplete line
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim().replace(/\r/g, "");
          if (!trimmed) continue;
          if (!headerSeen) {
            headerSeen = true;
            // Detect which column is "serialNumber" (case-insensitive)
            const headers = trimmed.split(",").map((h) => h.trim().toLowerCase());
            const idx = headers.findIndex((h) => h === "serialnumber" || h === "serial_number" || h === "serial");
            serialColIndex = idx >= 0 ? idx : 0;
            continue;
          }
          const cols = trimmed.split(",");
          const serial = (cols[serialColIndex] ?? cols[0]).trim();
          if (serial) lines.push(serial);
        }
      });

      file.on("end", () => {
        // Handle last line (no trailing newline)
        if (buffer.trim() && headerSeen) {
          const cols = buffer.trim().split(",");
          const serial = (cols[serialColIndex] ?? cols[0]).trim();
          if (serial) lines.push(serial);
        }
      });
    });

    bb.on("finish", async () => {
      const total = lines.length;

      if (total === 0) {
        emit({ error: "empty_csv" });
        res.end();
        return;
      }

      if (total > 1000) {
        emit({ error: "too_many_rows", max: 1000 });
        res.end();
        return;
      }

      // Check device quota before starting import
      try {
        const { checkDeviceQuota } = await import("../services/planEnforcement");
        const quotaCheck = await checkDeviceQuota(tenantId);
        if (!quotaCheck.allowed) {
          emit({
            error: "device_limit_reached",
            message: quotaCheck.message,
            currentCount: quotaCheck.currentCount,
            maxDevices: quotaCheck.maxDevices,
            plan: quotaCheck.plan,
          });
          res.end();
          return;
        }
      } catch (err) {
        console.warn("[bulk-import] quota check failed, proceeding:", err);
      }

      // Persist a bulk_import_job row so admins can see history
      const jobRow = await pool.query(
        `INSERT INTO bulk_import_jobs (tenant_id, created_by, total_rows, status)
         VALUES ($1, $2, $3, 'running')
         RETURNING id`,
        [tenantId, userId, total]
      );
      const jobId = jobRow.rows[0].id;

      let done   = 0;
      let errors = 0;

      // Process each serial number in sequence — avoids thundering-herd on the DB
      for (const serialNumber of lines) {
        try {
          // Validate format: 3-64 alphanumeric chars, dashes, underscores allowed
          if (!/^[A-Za-z0-9_-]{3,64}$/.test(serialNumber)) {
            throw new Error("invalid_serial_format");
          }

          await createDevice(tenantId, serialNumber, jobId, userId, undefined);
          done++;
          emit({ total, done, errors, current: serialNumber, status: "ok" });
        } catch (err) {
          errors++;
          done++;
          const safeMessage =
            process.env.NODE_ENV !== "production" && err instanceof Error
              ? err.message
              : "device_import_failed";
          emit({
            total,
            done,
            errors,
            current: serialNumber,
            status: "error",
            message: safeMessage,
          });
        }
      }

      // Update job status
      await pool.query(
        `UPDATE bulk_import_jobs
           SET status = $1, completed_at = NOW(), success_rows = $2, failed_rows = $3
         WHERE id = $4`,
        [errors === total ? "failed" : errors > 0 ? "partial" : "completed", done - errors, errors, jobId]
      );

      // Final event — done === total signals completion to the frontend
      emit({ total, done: total, errors, jobId, finished: true });
      res.end();
    });

    bb.on("error", (err: Error) => {
      console.error("[bulk-import] busboy error:", err);
      emit({ error: "parse_error", message: err.message });
      res.end();
    });

    req.pipe(bb);
  }
);

// ── GET /devices/bulk/jobs ─────────────────────────────────────────────────────
// Returns the tenant's bulk import history (last 20 jobs).
devicesImportRouter.get(
  "/devices/bulk/jobs",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT id, status, total_rows, success_rows, failed_rows, created_at, completed_at
       FROM bulk_import_jobs
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user!.tenantId]
    );
    return res.json(rows);
  }
);
