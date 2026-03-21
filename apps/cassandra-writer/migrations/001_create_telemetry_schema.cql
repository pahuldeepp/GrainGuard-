-- GrainGuard Cassandra Schema
-- Keyspace: grainguard_telemetry
-- Purpose: High-volume time-series telemetry storage
-- Access pattern: query by device_id + time range (most recent first)

CREATE KEYSPACE IF NOT EXISTS grainguard_telemetry
WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'dc1': 1
}
AND durable_writes = true;

USE grainguard_telemetry;

-- Primary time-series table
-- Partition key: (tenant_id, device_id) — keeps one device's data on same node
-- Clustering key: recorded_at DESC — most recent readings first
-- TTL: 90 days default (overridable per write)
CREATE TABLE IF NOT EXISTS telemetry_readings (
  tenant_id    UUID,
  device_id    UUID,
  recorded_at  TIMESTAMP,
  event_id     UUID,
  temperature  DOUBLE,
  humidity     DOUBLE,
  PRIMARY KEY ((tenant_id, device_id), recorded_at)
) WITH CLUSTERING ORDER BY (recorded_at DESC)
  AND default_time_to_live = 7776000
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 1
  }
  AND comment = 'Time-series telemetry readings. Partitioned by tenant+device, ordered by time DESC. TWCS compaction for time-series efficiency.';

-- Rollup table for hourly aggregates (used for dashboard charts)
CREATE TABLE IF NOT EXISTS telemetry_hourly_rollup (
  tenant_id    UUID,
  device_id    UUID,
  hour_bucket  TIMESTAMP,
  avg_temp     DOUBLE,
  min_temp     DOUBLE,
  max_temp     DOUBLE,
  avg_humidity DOUBLE,
  reading_count INT,
  PRIMARY KEY ((tenant_id, device_id), hour_bucket)
) WITH CLUSTERING ORDER BY (hour_bucket DESC)
  AND default_time_to_live = 31536000
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 7
  }
  AND comment = 'Hourly rollups for dashboard charts. Pre-aggregated to avoid full scans.';

-- Index for querying all devices in a tenant (used sparingly)
CREATE INDEX IF NOT EXISTS ON telemetry_readings (tenant_id);
