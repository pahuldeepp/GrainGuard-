ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_outbox_correlation ON outbox_events(correlation_id) WHERE correlation_id IS NOT NULL;
