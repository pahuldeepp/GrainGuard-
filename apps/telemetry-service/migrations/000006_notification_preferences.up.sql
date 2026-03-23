-- 000006_notification_preferences.up.sql
-- Per-user notification preference settings.
-- Controls which channels (email, webhook) a user receives per event category.

CREATE TABLE IF NOT EXISTS notification_preferences (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL,           -- auth0 sub
  email_alerts BOOLEAN     NOT NULL DEFAULT TRUE,
  email_weekly_digest BOOLEAN NOT NULL DEFAULT TRUE,
  webhook_alerts      BOOLEAN NOT NULL DEFAULT FALSE,
  alert_levels TEXT[]      NOT NULL DEFAULT '{warn,critical}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_prefs_tenant ON notification_preferences (tenant_id);

DROP TRIGGER IF EXISTS notification_prefs_set_updated_at ON notification_preferences;
CREATE TRIGGER notification_prefs_set_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
