CREATE TABLE IF NOT EXISTS processed_events (
    event_id     UUID        PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_telemetry_latest (
    device_id    UUID             PRIMARY KEY,
    temperature  DOUBLE PRECISION NOT NULL,
    humidity     DOUBLE PRECISION NOT NULL,
    recorded_at  TIMESTAMPTZ      NOT NULL,
    updated_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    version      BIGINT           NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_device_telemetry_recorded_at
    ON device_telemetry_latest (recorded_at);
