import { Pool } from "pg";

// Write pool — points to primary DB, not read replica
export const writePool = new Pool({
  host:     process.env.WRITE_DB_HOST     || "postgres",
  port:     parseInt(process.env.WRITE_DB_PORT || "5432"),
  database: process.env.WRITE_DB_NAME     || "grainguard",
  user:     process.env.WRITE_DB_USER     || "postgres",
  password: process.env.WRITE_DB_PASSWORD || "postgres",
  max: 5,
});

export type AuditEventType =
  | "device.created"
  | "device.creation_failed"
  | "device.telemetry_queried"
  | "auth.unauthorized"
  | "admin.action";

export interface AuditEvent {
  eventType: AuditEventType;
  actorId: string;
  tenantId: string;
  resourceType: string;
  resourceId?: string;
  payload?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

// Critical events that MUST be logged — throw on failure so the caller knows
const CRITICAL_EVENTS: Set<string> = new Set([
  "auth.unauthorized",
  "admin.action",
]);

export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await writePool.query(
      `INSERT INTO audit_events
       (event_type, actor_id, tenant_id, resource_type, resource_id, payload, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.eventType,
        event.actorId,
        event.tenantId,
        event.resourceType,
        event.resourceId || null,
        JSON.stringify(event.payload || {}),
        event.ipAddress || null,
        event.userAgent || null,
      ]
    );
  } catch (err) {
    console.error("[audit] FAILED to log event:", event.eventType, err);
    // Critical audit events must not be silently lost — re-throw so callers can handle
    if (CRITICAL_EVENTS.has(event.eventType)) {
      throw new Error(`Critical audit event lost: ${event.eventType}`);
    }
  }
}

