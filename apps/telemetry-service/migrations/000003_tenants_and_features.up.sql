-- ── Tenants ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT        NOT NULL,
    slug                    TEXT        NOT NULL UNIQUE,
    email                   TEXT        NOT NULL,
    plan                    TEXT        NOT NULL DEFAULT 'free',
    subscription_status     TEXT        NOT NULL DEFAULT 'trialing',
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT        UNIQUE,
    stripe_price_id         TEXT,
    auth0_org_id            TEXT,
    sso_connection_id       TEXT,
    sso_connection_type     TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug         ON tenants(slug);
CREATE INDEX idx_tenants_stripe_cust  ON tenants(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ── Tenant Users ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_users (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    auth_user_id TEXT        NOT NULL,
    email        TEXT        NOT NULL,
    role         TEXT        NOT NULL DEFAULT 'member',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, auth_user_id)
);

CREATE INDEX idx_tenant_users_tenant   ON tenant_users(tenant_id);
CREATE INDEX idx_tenant_users_auth_uid ON tenant_users(auth_user_id);

-- ── Tenant Invites ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_invites (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       TEXT        NOT NULL,
    role        TEXT        NOT NULL DEFAULT 'member',
    invited_by  TEXT        NOT NULL,
    token       TEXT        NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
    accepted_at TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenant_invites_tenant ON tenant_invites(tenant_id);
CREATE INDEX idx_tenant_invites_email  ON tenant_invites(email);

-- ── API Keys ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    key_hash     TEXT        NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_hash   ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- ── Alert Rules ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    metric     TEXT        NOT NULL,
    operator   TEXT        NOT NULL,
    threshold  DOUBLE PRECISION NOT NULL,
    enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_rules_tenant ON alert_rules(tenant_id);

-- ── Bulk Import Jobs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulk_import_jobs (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id      TEXT        NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'pending',
    total_rows   INT         NOT NULL DEFAULT 0,
    success_rows INT         NOT NULL DEFAULT 0,
    failed_rows  INT         NOT NULL DEFAULT 0,
    errors       JSONB       NOT NULL DEFAULT '[]',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_bulk_import_jobs_tenant ON bulk_import_jobs(tenant_id, created_at DESC);

-- ── Processed Events (idempotency) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_events (
    event_id   TEXT        PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Seed: demo tenant (matches Auth0 test user app_metadata) ───────────────
INSERT INTO tenants (id, name, slug, email, plan, subscription_status)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    'Demo Organisation',
    'demo-organisation',
    'pahuldeepsingh4411@gmail.com',
    'free',
    'trialing'
) ON CONFLICT (id) DO NOTHING;

-- Seed: admin user for demo tenant
INSERT INTO tenant_users (tenant_id, auth_user_id, email, role)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    'google-oauth2|114152888774048124131',
    'pahuldeepsingh4411@gmail.com',
    'admin'
) ON CONFLICT (tenant_id, auth_user_id) DO NOTHING;
