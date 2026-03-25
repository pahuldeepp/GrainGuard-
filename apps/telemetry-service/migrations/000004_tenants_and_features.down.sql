-- 000004_tenants_and_features.down.sql
-- Rolls back the tenants, feature flags, alert rules, audit log, and billing tables.

DROP TABLE IF EXISTS tenant_billing;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS alert_rules;
DROP TABLE IF EXISTS tenant_invites;
DROP TABLE IF EXISTS tenant_users;
DROP TABLE IF EXISTS feature_flags;
DROP TABLE IF EXISTS tenants;

DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
