CREATE TABLE IF NOT EXISTS sagas (
  saga_id UUID PRIMARY KEY,
  saga_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  current_step TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sagas_status ON sagas(status);
CREATE INDEX IF NOT EXISTS idx_sagas_type ON sagas(saga_type);