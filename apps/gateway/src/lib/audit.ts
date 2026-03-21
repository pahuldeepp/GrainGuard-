import { pool } from "../database/db";

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

export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await pool.query(
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
    console.error("[audit] failed to log event:", event.eventType, err);
  }
}
