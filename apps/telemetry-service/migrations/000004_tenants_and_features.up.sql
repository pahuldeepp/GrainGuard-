-- 000004_tenants_and_features.up.sql
-- Creates tenant / feature flag schema.
-- ⚠️  No seed data here — use scripts/seed/seed-dev.sql for local dev
--     and scripts/seed/seed-staging.sql for staging.

-- ── Tenants ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL UNIQUE,
  plan        TEXT        NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Feature flags ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  flag        TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, flag)
);

-- ── Tenant users ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  auth_user_id TEXT        NOT NULL,
  email        TEXT,
  role         TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, auth_user_id)
);

-- ── Tenant invites ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  role        TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  invited_by  TEXT        NOT NULL,
  token       TEXT        NOT NULL UNIQUE,
  accepted_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Alert rules ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  metric      TEXT        NOT NULL,
  operator    TEXT        NOT NULL,
  threshold   NUMERIC     NOT NULL,
  level       TEXT        NOT NULL DEFAULT 'warn' CHECK (level IN ('warn', 'critical')),
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Audit log ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_id      TEXT        NOT NULL,
  actor_email   TEXT,
  event_type    TEXT        NOT NULL,
  resource_id   TEXT,
  resource_type TEXT,
  meta          JSONB,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at DESC);

-- ── Billing ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_billing (
  tenant_id              UUID PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan                   TEXT        NOT NULL DEFAULT 'free',
  status                 TEXT        NOT NULL DEFAULT 'none',
  trial_ends_at          TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);