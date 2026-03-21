-- Audit event log — immutable append-only record of all privileged actions
-- No UPDATE or DELETE grants — only INSERT and SELECT
CREATE TABLE IF NOT EXISTS audit_events (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type    TEXT        NOT NULL,
    actor_id      TEXT        NOT NULL,
    tenant_id     UUID        NOT NULL,
    resource_type TEXT        NOT NULL,
    resource_id   TEXT,
    payload       JSONB       NOT NULL DEFAULT '{}',
    ip_address    TEXT,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_events_tenant_id ON audit_events (tenant_id, created_at DESC);
CREATE INDEX idx_audit_events_actor_id  ON audit_events (actor_id, created_at DESC);
CREATE INDEX idx_audit_events_type      ON audit_events (event_type, created_at DESC);

-- Immutable: only INSERT allowed for app role
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;

COMMENT ON TABLE audit_events IS 
'Immutable audit log. Append-only. Every privileged action writes here.';

-- Enforce true immutability via trigger (blocks even table owner)
CREATE OR REPLACE FUNCTION audit_events_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is immutable — UPDATE and DELETE are not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
