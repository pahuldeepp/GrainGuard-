-- 000007_saas_columns.down.sql
DROP TABLE IF EXISTS stripe_webhook_events;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS sso_connection_type,
  DROP COLUMN IF EXISTS sso_connection_id,
  DROP COLUMN IF EXISTS auth0_org_id,
  DROP COLUMN IF EXISTS subscription_status;
