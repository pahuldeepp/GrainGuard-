DROP POLICY IF EXISTS tenant_isolation_telemetry_history ON device_telemetry_history;
DROP INDEX IF EXISTS idx_device_telemetry_history_recorded_at;
DROP INDEX IF EXISTS idx_device_telemetry_history_tenant_id;
DROP TABLE IF EXISTS device_telemetry_history;
