-- Migration: Add Row-Level Security for multi-tenant isolation
-- ADR-005: Postgres RLS for standard-tier tenant isolation
-- This adds database-level tenant isolation as a second layer
-- (first layer is application-level tenant filtering in queries)

-- Enable RLS on telemetry tables
ALTER TABLE device_telemetry_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_projections ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'device_telemetry_history'
  ) THEN
    ALTER TABLE device_telemetry_history ENABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- Create tenant-scoped role for application queries
-- The app sets this variable before each query
CREATE POLICY tenant_isolation_telemetry_latest
  ON device_telemetry_latest
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'device_telemetry_history'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY tenant_isolation_telemetry_history
        ON device_telemetry_history
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
    $policy$;
  END IF;
END
$$;

CREATE POLICY tenant_isolation_device_projections
  ON device_projections
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Create app role with restricted access (no superuser bypass)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grainguard_app') THEN
    CREATE ROLE grainguard_app LOGIN PASSWORD 'grainguard_app_password';
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON device_telemetry_latest TO grainguard_app;
GRANT SELECT ON device_projections TO grainguard_app;
GRANT SELECT, INSERT ON processed_events TO grainguard_app;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'device_telemetry_history'
  ) THEN
    GRANT SELECT, INSERT ON device_telemetry_history TO grainguard_app;
  END IF;
END
$$;

-- Superuser (postgres) bypasses RLS by default — this is intentional
-- for migrations and admin operations
-- Application connections use grainguard_app role which is subject to RLS
