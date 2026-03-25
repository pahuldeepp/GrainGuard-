-- scripts/seed/seed-dev.sql
-- Local development seed data.
-- Run via:  psql $DATABASE_URL -f scripts/seed/seed-dev.sql
--
-- Required env vars (set in .env.local or export before running):
--   SEED_TENANT_NAME      e.g. "Acme Dev"
--   SEED_ADMIN_EMAIL      e.g. "you@example.com"
--   SEED_ADMIN_AUTH_ID    e.g. "auth0|abc123..."   (your local Auth0 user sub)
--
-- Uses psql \getenv to pull values — never commit real credentials here.

\getenv SEED_TENANT_NAME   SEED_TENANT_NAME
\getenv SEED_ADMIN_EMAIL   SEED_ADMIN_EMAIL
\getenv SEED_ADMIN_AUTH_ID SEED_ADMIN_AUTH_ID

-- ── Dev tenant ────────────────────────────────────────────────────────────────
INSERT INTO tenants (id, name, slug, plan, created_at, updated_at)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  :'SEED_TENANT_NAME',
  'dev',
  'professional',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE
  SET name       = EXCLUDED.name,
      updated_at = NOW();

-- ── Dev admin user ────────────────────────────────────────────────────────────
INSERT INTO tenant_users (id, tenant_id, auth_user_id, email, role, created_at)
VALUES (
  gen_random_uuid(),
  '11111111-1111-1111-1111-111111111111',
  :'SEED_ADMIN_AUTH_ID',
  :'SEED_ADMIN_EMAIL',
  'admin',
  NOW()
)
ON CONFLICT (tenant_id, auth_user_id) DO UPDATE
  SET email      = EXCLUDED.email,
      role       = EXCLUDED.role;

-- ── Default alert rules for dev tenant ───────────────────────────────────────
INSERT INTO alert_rules (id, tenant_id, name, metric, operator, threshold, level, enabled)
VALUES
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'High temperature warning',  'temperature', '>=', 30, 'warn',     TRUE),
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'Critical temperature',       'temperature', '>=', 35, 'critical', TRUE),
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'High humidity warning',      'humidity',    '>=', 70, 'warn',     TRUE),
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'Critical humidity',          'humidity',    '>=', 80, 'critical', TRUE)
ON CONFLICT DO NOTHING;

-- ── Feature flags ─────────────────────────────────────────────────────────────
INSERT INTO feature_flags (tenant_id, flag, enabled)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'csv_export',   TRUE),
  ('11111111-1111-1111-1111-111111111111', 'slack_alerts', TRUE),
  ('11111111-1111-1111-1111-111111111111', 'api_access',   TRUE)
ON CONFLICT (tenant_id, flag) DO UPDATE SET enabled = EXCLUDED.enabled;

-- ── Fake devices (50 devices) ─────────────────────────────────────────────────
INSERT INTO device_projections (device_id, tenant_id, serial_number, created_at, updated_at)
SELECT
  gen_random_uuid(),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'SN-' || LPAD(i::text, 4, '0'),
  NOW() - (random() * interval '30 days'),
  NOW()
FROM generate_series(1, 50) i
ON CONFLICT DO NOTHING;

-- ── Latest telemetry snapshot ─────────────────────────────────────────────────
INSERT INTO device_telemetry_latest (device_id, tenant_id, temperature, humidity, recorded_at, updated_at, version)
SELECT
  d.device_id,
  d.tenant_id,
  15 + (random() * 25),
  35 + (random() * 55),
  NOW() - (random() * interval '1 hour'),
  NOW(),
  1
FROM device_projections d
WHERE d.tenant_id = '11111111-1111-1111-1111-111111111111'
ON CONFLICT (device_id) DO UPDATE
  SET temperature = EXCLUDED.temperature,
      humidity    = EXCLUDED.humidity,
      updated_at  = EXCLUDED.updated_at;

-- ── Telemetry history (50 devices × 20 000 readings = 1 M rows) ───────────────
INSERT INTO device_telemetry_history (device_id, tenant_id, temperature, humidity, recorded_at)
SELECT
  d.device_id,
  d.tenant_id,
  15 + (random() * 30),
  40 + (random() * 50),
  NOW() - (s.i * interval '1 minute')
FROM device_projections d
CROSS JOIN generate_series(1, 20000) AS s(i)
WHERE d.tenant_id = '11111111-1111-1111-1111-111111111111'
LIMIT 1000000
ON CONFLICT DO NOTHING;