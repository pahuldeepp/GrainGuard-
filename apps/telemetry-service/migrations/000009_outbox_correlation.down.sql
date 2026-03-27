DROP INDEX IF EXISTS idx_outbox_correlation;
ALTER TABLE outbox_events DROP COLUMN IF EXISTS correlation_id;
