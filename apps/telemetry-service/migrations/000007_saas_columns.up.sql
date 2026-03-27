-- 000007_saas_columns.up.sql
-- Adds SaaS operational columns missing from the initial schema.

-- Tenant contact email used during signup and account export
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS email TEXT;

-- subscription_status on tenants (mirrors tenant_billing.status for fast joins)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none';

-- Grace-period enforcement reads the active billing period end from tenants
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

-- auth0_org_id for SSO / Auth0 Organizations
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS auth0_org_id TEXT;

-- sso_connection_id and sso_connection_type for SSO management
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS sso_connection_id   TEXT,
  ADD COLUMN IF NOT EXISTS sso_connection_type TEXT;

-- Stripe webhook idempotency — prevents double-processing on Stripe retries
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id  TEXT        PRIMARY KEY,
  event_type       TEXT        NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
