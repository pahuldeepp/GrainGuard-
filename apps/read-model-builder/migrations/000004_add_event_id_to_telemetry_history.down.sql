DROP INDEX IF EXISTS idx_device_telemetry_history_device_recorded_at;

DELETE FROM device_telemetry_history a
USING device_telemetry_history b
WHERE a.ctid < b.ctid
  AND a.device_id = b.device_id
  AND a.recorded_at = b.recorded_at;

ALTER TABLE device_telemetry_history
    DROP CONSTRAINT IF EXISTS device_telemetry_history_pkey;

ALTER TABLE device_telemetry_history
    ADD CONSTRAINT device_telemetry_history_pkey PRIMARY KEY (device_id, recorded_at);

ALTER TABLE device_telemetry_history
    DROP COLUMN IF EXISTS event_id;
