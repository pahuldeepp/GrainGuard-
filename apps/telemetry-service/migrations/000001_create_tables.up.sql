CREATE TABLE IF NOT EXISTS devices (
    id            UUID PRIMARY KEY,
    tenant_id     UUID        NOT NULL,
    serial_number TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, serial_number)
);

CREATE TABLE IF NOT EXISTS telemetry_readings (
    id          UUID PRIMARY KEY,
    device_id   UUID             NOT NULL REFERENCES devices(id),
    temperature DOUBLE PRECISION NOT NULL,
    humidity    DOUBLE PRECISION NOT NULL,
    recorded_at TIMESTAMPTZ      NOT NULL,
    created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_id  ON telemetry_readings(device_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_recorded_at ON telemetry_readings(recorded_at DESC);
