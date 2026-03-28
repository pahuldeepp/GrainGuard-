-- 000010_billing_periods.up.sql
-- Adds the current billing period end to tenants for quota enforcement and UI reads.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
