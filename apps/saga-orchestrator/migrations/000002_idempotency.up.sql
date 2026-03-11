CREATE TABLE IF NOT EXISTS saga_processed_events (
    event_id    TEXT        PRIMARY KEY,
    saga_id     UUID        NOT NULL,
    processed_at TIMESTAMP  NOT NULL DEFAULT NOW()
);
