CREATE TABLE IF NOT EXISTS device_telemetry_history (
    device_id    UUID             NOT NULL,
    tenant_id    UUID             NOT NULL,
    temperature  DOUBLE PRECISION NOT NULL,
    humidity     DOUBLE PRECISION NOT NULL,
    recorded_at  TIMESTAMPTZ      NOT NULL,
    created_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    PRIMARY KEY (device_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_device_telemetry_history_tenant_id
    ON device_telemetry_history (tenant_id);

CREATE INDEX IF NOT EXISTS idx_device_telemetry_history_recorded_at
    ON device_telemetry_history (recorded_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grainguard_app') THEN
    CREATE ROLE grainguard_app LOGIN PASSWORD 'grainguard_app_password';
  END IF;
END
$$;

ALTER TABLE device_telemetry_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_telemetry_history ON device_telemetry_history;
CREATE POLICY tenant_isolation_telemetry_history
  ON device_telemetry_history
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

GRANT SELECT, INSERT ON device_telemetry_history TO grainguard_app;
