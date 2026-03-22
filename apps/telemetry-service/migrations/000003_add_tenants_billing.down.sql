-- Rollback: remove billing columns and invite table

DROP TABLE IF EXISTS tenant_invites;

DROP INDEX IF EXISTS idx_tenants_stripe_sub;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id,
  DROP COLUMN IF EXISTS subscription_status,
  DROP COLUMN IF EXISTS current_period_end,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS plan;
