CREATE TABLE IF NOT EXISTS device_telemetry_latest (
    device_id UUID PRIMARY KEY,
    temperature DOUBLE PRECISION,
    humidity DOUBLE PRECISION,
    recorded_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT NOW(),
    version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);