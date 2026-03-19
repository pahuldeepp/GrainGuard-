# ADR-004: Cassandra TWCS for Telemetry Time-Series Storage

## Status
Accepted (planned for Phase 3 implementation)

## Date
2024-03-19

## Context
GrainGuard targets 500M active devices at 1 reading/minute = 8.3M events/sec
peak ingest. Current Postgres read model stores telemetry in
device_telemetry_latest (one row per device) and device_telemetry_history
(all readings).

At scale Postgres breaks down:
- device_telemetry_history at 500M devices x 1440 readings/day = 720B rows/day
- B-tree indexes degrade under write-heavy time-series workloads
- Vacuum/autovacuum contention at high write rates
- Range queries on time columns require full index scans

## Decision
Replace Postgres telemetry history storage with Apache Cassandra using
TimeWindowCompactionStrategy (TWCS) for time-series data.

## Schema Design
```cql
CREATE TABLE telemetry_readings (
  tenant_id  UUID,
  device_id  UUID,
  recorded_at TIMESTAMP,
  temperature FLOAT,
  humidity    FLOAT,
  PRIMARY KEY ((tenant_id, device_id), recorded_at)
) WITH CLUSTERING ORDER BY (recorded_at DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 1
  }
  AND default_time_to_live = 7776000; -- 90 days TTL
```

## Rationale

### Access pattern alignment
Cassandra partitions by (tenant_id, device_id). All time-range queries for
a specific device hit a single partition — O(1) partition lookup + O(log n)
clustering key scan. At 500M devices this is consistently fast.

### TWCS compaction
TimeWindowCompactionStrategy groups SSTables by time window (1 day). Compaction
only merges SSTables within the same window. Old cold windows are never
re-compacted. This is optimal for append-only time-series data.

### TTL-based retention
90-day TTL automatically expires old readings at the storage engine level.
No DELETE queries needed. Old SSTables simply expire and are dropped.

### AP availability
Cassandra with RF=3 tolerates 1 node failure with LOCAL_QUORUM reads.
For telemetry ingest, AP over CP is the right trade-off — a brief period
of stale data is acceptable. Device metadata (OLTP) remains in Postgres (CP).

## Consequences

### Positive
- Linear write throughput scaling (add nodes = add throughput)
- Predictable read latency regardless of data volume
- Automatic TTL expiry eliminates manual data retention jobs
- No write amplification from B-tree maintenance

### Negative
- Cassandra is operationally complex (compaction tuning, repairs)
- No ad-hoc queries (strict partition key requirement)
- Lightweight transactions (Paxos) are expensive — avoided
- Different consistency model requires explicit design

### Mitigations
- AWS Keyspaces (managed Cassandra) eliminates operational overhead
- CQRS pattern isolates Cassandra to read-only telemetry queries
- Materialized views in Postgres for dashboard aggregations

## Migration Strategy
1. Deploy Cassandra alongside Postgres (dual-write period)
2. Backfill historical data from Postgres to Cassandra
3. Switch read queries to Cassandra
4. Remove Postgres telemetry_history table after validation

## References
- Cassandra TWCS documentation
- DDIA Chapter 3: Storage engines and compaction strategies
