INSERT INTO device_projections (device_id, tenant_id, serial_number, created_at, updated_at)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111'::uuid, 'SN-' || LPAD(i::text, 4, '0'), NOW() - (random() * interval '30 days'), NOW()
FROM generate_series(1, 50) i ON CONFLICT DO NOTHING;

INSERT INTO device_telemetry_latest (device_id, tenant_id, temperature, humidity, recorded_at, updated_at, version)
SELECT d.device_id, d.tenant_id, 15 + (random() * 25), 35 + (random() * 55), NOW() - (random() * interval '1 hour'), NOW(), 1
FROM device_projections d ON CONFLICT (device_id) DO UPDATE SET temperature = EXCLUDED.temperature, humidity = EXCLUDED.humidity, updated_at = EXCLUDED.updated_at;
