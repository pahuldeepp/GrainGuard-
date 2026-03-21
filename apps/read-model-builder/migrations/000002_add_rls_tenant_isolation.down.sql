DROP POLICY IF EXISTS tenant_isolation_telemetry_latest ON device_telemetry_latest;
DROP POLICY IF EXISTS tenant_isolation_telemetry_history ON device_telemetry_history;
DROP POLICY IF EXISTS tenant_isolation_device_projections ON device_projections;

ALTER TABLE device_telemetry_latest DISABLE ROW LEVEL SECURITY;
ALTER TABLE device_telemetry_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE device_projections DISABLE ROW LEVEL SECURITY;

DROP ROLE IF EXISTS grainguard_app;
