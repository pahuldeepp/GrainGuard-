import { writePool as pool } from "./db";

// ── Audit event types ────────────────────────────────────────────────────────
export type AuditEventType =
  // Auth
  | "auth.login"
  | "auth.logout"
  | "auth.sso_configured"
  | "auth.sso_removed"
  // Team
  | "team.member_invited"
  | "team.invite_accepted"
  | "team.invite_revoked"
  | "team.member_removed"
  | "team.member_role_changed"
  // Alert rules
  | "alert_rule.created"
  | "alert_rule.updated"
  | "alert_rule.deleted"
  // Billing
  | "billing.checkout_started"
  | "billing.subscription_created"
  | "billing.subscription_cancelled"
  | "billing.subscription_updated"
  | "billing.portal_accessed"
  | "device.created"
  | "device.creation_failed"
  | "device.registered"
  | "webhook_endpoint.created"
  // API keys
  | "api_key.created"
  | "api_key.revoked"
  // Devices
  | "device.registered"
  | "device.created"
  | "device.creation_failed"
  | "device.deleted"
  // Webhooks
  | "webhook_endpoint.created";

export interface AuditEvent {
  tenantId: string;
  actorId: string;       // auth0 sub
  actorEmail?: string;
  eventType: AuditEventType;
  resourceId?: string;   // e.g. invite id, rule id, device id
  resourceType?: string; // e.g. "invite", "alert_rule", "device"
  meta?: Record<string, unknown>;
  ipAddress?: string;
}

export async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs
         (id, tenant_id, actor_id, actor_email, event_type,
          resource_id, resource_type, meta, ip_address, created_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        event.tenantId,
        event.actorId,
        event.actorEmail ?? null,
        event.eventType,
        event.resourceId ?? null,
        event.resourceType ?? null,
        event.meta ? JSON.stringify(event.meta) : null,
        event.ipAddress ?? null,
      ]
    );
  } catch (err) {
    // Audit failures must never crash the request — log and continue
    console.error("[audit] failed to write audit log:", err);
  }
}