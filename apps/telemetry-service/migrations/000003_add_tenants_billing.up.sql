-- Migration: add billing + invite columns to tenants table
-- Run AFTER the base tenants table already exists (000001)

-- Stripe fields on the tenants row
-- stripe_customer_id: Stripe's customer object ID (cus_xxx)
-- stripe_subscription_id: active subscription ID (sub_xxx)
-- subscription_status: mirrors Stripe status ('trialing','active','past_due','canceled')
-- current_period_end: when the current billing period ends — used for access gating
-- trial_ends_at: if the account is in trial, when it expires
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status     TEXT    NOT NULL DEFAULT 'trialing',
  ADD COLUMN IF NOT EXISTS current_period_end      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS plan                    TEXT    NOT NULL DEFAULT 'free';

-- Index so webhook handler can find a tenant by subscription ID in O(log n)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_stripe_sub
  ON tenants (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Pending invitations table
-- Rows are created when an admin invites someone who hasn't logged in yet.
-- On first Auth0 login we look up the invite by email and create the tenant_users row.
CREATE TABLE IF NOT EXISTS tenant_invites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  role        TEXT        NOT NULL DEFAULT 'member',
  invited_by  TEXT        NOT NULL,   -- Auth0 sub of the admin who sent the invite
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,            -- NULL until the invitee logs in

  -- One pending invite per (tenant, email) — admins can re-invite to change the role
  CONSTRAINT uq_tenant_invite UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_tenant_invites_email
  ON tenant_invites (email);          -- fast lookup on login
