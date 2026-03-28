CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE device_telemetry_history
    ADD COLUMN IF NOT EXISTS event_id UUID DEFAULT gen_random_uuid();

UPDATE device_telemetry_history
SET event_id = gen_random_uuid()
WHERE event_id IS NULL;

ALTER TABLE device_telemetry_history
    ALTER COLUMN event_id SET NOT NULL,
    ALTER COLUMN event_id SET DEFAULT gen_random_uuid();

ALTER TABLE device_telemetry_history
    DROP CONSTRAINT IF EXISTS device_telemetry_history_pkey;

ALTER TABLE device_telemetry_history
    ADD CONSTRAINT device_telemetry_history_pkey PRIMARY KEY (event_id);

CREATE INDEX IF NOT EXISTS idx_device_telemetry_history_device_recorded_at
    ON device_telemetry_history (device_id, recorded_at DESC);
