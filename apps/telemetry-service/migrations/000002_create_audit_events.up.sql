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
