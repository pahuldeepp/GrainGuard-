DROP TABLE IF EXISTS tenant_usage;
DROP INDEX IF EXISTS idx_devices_tenant_disabled;
ALTER TABLE devices DROP COLUMN IF EXISTS disabled;
