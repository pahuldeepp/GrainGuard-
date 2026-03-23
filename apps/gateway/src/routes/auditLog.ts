import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../database/db";

export const auditLogRouter = Router();

// ── GET /audit-logs ────────────────────────────────────────────────────────────
// Returns paginated audit events for the current tenant.
// Supports filtering by event_type, actor, resource, and date range.
// Cursor-based pagination via the `before` query param (ISO timestamp).
//
// Query params:
//   limit     number  (default 50, max 200)
//   before    string  ISO 8601 timestamp — return events before this time
//   event_type string  filter by event type (e.g. "device.created")
//   actor_id  string  filter by actor (user sub)
auditLogRouter.get(
  "/audit-logs",
  authMiddleware,
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const limit    = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
    const before   = req.query.before  as string | undefined;  // ISO 8601 cursor
    const eventType= req.query.event_type as string | undefined;
    const actorId  = req.query.actor_id   as string | undefined;

    // Build WHERE clauses dynamically — parameterised to prevent SQL injection
    const conditions: string[] = ["tenant_id = $1"];
    const params: any[]        = [tenantId];

    if (before) {
      params.push(new Date(before).toISOString());
      conditions.push(`created_at < $${params.length}`);
    }
    if (eventType) {
      params.push(eventType);
      conditions.push(`event_type = $${params.length}`);
    }
    if (actorId) {
      params.push(actorId);
      conditions.push(`actor_id = $${params.length}`);
    }

    params.push(limit + 1); // fetch one extra to know if there's a next page

    const { rows } = await pool.query(
      `SELECT id, event_type, actor_id, resource_type, resource_id,
              payload, ip_address, user_agent, created_at
       FROM audit_events
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    // Pagination: if we got limit+1 rows there are more
    const hasMore = rows.length > limit;
    const events  = hasMore ? rows.slice(0, limit) : rows;

    return res.json({
      events,
      hasMore,
      // Pass this as `before` in the next request to get the next page
      nextCursor: hasMore ? events[events.length - 1].created_at : null,
    });
  }
);

// ── GET /audit-logs/export ─────────────────────────────────────────────────────
// Downloads audit logs as CSV for compliance purposes (admin only).
// Same filters as the list endpoint.
auditLogRouter.get(
  "/audit-logs/export",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!req.user!.roles?.includes("admin")) {
      return res.status(403).json({ error: "forbidden" });
    }

    const tenantId  = req.user!.tenantId;
    const eventType = req.query.event_type as string | undefined;
    const actorId   = req.query.actor_id   as string | undefined;

    const conditions: string[] = ["tenant_id = $1"];
    const params: any[]        = [tenantId];

    if (eventType) {
      params.push(eventType);
      conditions.push(`event_type = $${params.length}`);
    }
    if (actorId) {
      params.push(actorId);
      conditions.push(`actor_id = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT id, event_type, actor_id, resource_type, resource_id,
              ip_address, created_at
       FROM audit_events
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT 10000`,   // cap at 10k rows for export safety
      params
    );

    // Build CSV string in memory — these are small enough
    const header = "id,event_type,actor_id,resource_type,resource_id,ip_address,created_at";
    const csvRows = rows.map((r: Record<string, unknown>) =>
      [r["id"], r["event_type"], r["actor_id"], r["resource_type"], r["resource_id"], r["ip_address"], r["created_at"]]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)  // CSV-escape
        .join(",")
    );

    const csv = [header, ...csvRows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-${tenantId}-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    return res.send(csv);
  }
);
