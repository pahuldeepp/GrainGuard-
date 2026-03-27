DROP TABLE IF EXISTS bulk_import_jobs;
DROP TABLE IF EXISTS alert_rules;

DROP INDEX IF EXISTS idx_tenants_auth0_org;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS auth0_org_id,
  DROP COLUMN IF EXISTS sso_connection_id,
  DROP COLUMN IF EXISTS sso_connection_type;
