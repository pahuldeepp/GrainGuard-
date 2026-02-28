create table if not EXISTS device_telementry_latest (
      device_id   UUID PRIMARY KEY,
    temperature DOUBLE PRECISION NOT NULL,
    humidity    DOUBLE PRECISION NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);