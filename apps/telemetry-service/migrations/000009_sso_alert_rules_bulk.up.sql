-- Migration 009: SSO columns + alert_rules table + bulk_import_jobs table

-- ── SSO columns on tenants ────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS auth0_org_id         TEXT,   -- Auth0 Organization ID (org_xxx)
  ADD COLUMN IF NOT EXISTS sso_connection_id    TEXT,   -- Auth0 Connection ID (con_xxx)
  ADD COLUMN IF NOT EXISTS sso_connection_type  TEXT;   -- 'saml' | 'oidc'

-- Unique index — one org per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_auth0_org
  ON tenants (auth0_org_id)
  WHERE auth0_org_id IS NOT NULL;

-- ── Alert rules ───────────────────────────────────────────────────────────────
-- Defines when workflow-alerts should fire for devices in a tenant.
-- The workflow-alerts service reads these rows and evaluates them against
-- incoming risk score events from Kafka.
CREATE TABLE IF NOT EXISTS alert_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,                     -- human-readable label
  metric      TEXT        NOT NULL,                     -- 'temperature' | 'humidity' | 'co2' | ...
  operator    TEXT        NOT NULL,                     -- '>' | '<' | '>=' | '<=' | '=='
  threshold   FLOAT       NOT NULL,                     -- numeric threshold value
  device_type TEXT,                                     -- NULL = apply to all device types
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_tenant
  ON alert_rules (tenant_id)
  WHERE enabled = true;

-- ── Bulk import jobs ──────────────────────────────────────────────────────────
-- Tracks the status of CSV bulk device import operations.
-- The import endpoint writes a row here before starting processing,
-- then updates it when done. Admins can see past imports in the UI.
CREATE TABLE IF NOT EXISTS bulk_import_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by   TEXT        NOT NULL,                    -- user sub who uploaded
  total_rows   INT         NOT NULL DEFAULT 0,
  success_rows INT         NOT NULL DEFAULT 0,
  error_rows   INT         NOT NULL DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'running',  -- 'running' | 'completed' | 'partial' | 'failed'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_tenant
  ON bulk_import_jobs (tenant_id, created_at DESC);
