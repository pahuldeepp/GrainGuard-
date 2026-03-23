CREATE TABLE IF NOT EXISTS outbox_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type TEXT        NOT NULL,
    aggregate_id   UUID        NOT NULL,
    event_type     TEXT        NOT NULL,
    payload        JSONB       NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at   TIMESTAMPTZ NULL
);

-- Partial index: only unpublished rows — keeps the poller query fast
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON outbox_events(created_at ASC)
    WHERE published_at IS NULL;
