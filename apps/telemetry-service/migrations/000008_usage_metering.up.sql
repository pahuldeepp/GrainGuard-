-- 000008_usage_metering.up.sql
-- Adds: device disabled flag, daily usage tracking

ALTER TABLE devices ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_devices_tenant_disabled ON devices(tenant_id, disabled);

CREATE TABLE IF NOT EXISTS tenant_usage (
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day         DATE        NOT NULL DEFAULT CURRENT_DATE,
  event_count BIGINT      NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, day)
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_day ON tenant_usage(day);
