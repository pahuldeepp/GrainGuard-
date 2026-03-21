# Kafka Ingest Load Test Baseline

## Test Configuration
- Workers: 10
- Target rate: 5000 events/sec
- Duration: 30s
- Partitions: 6
- Devices: 50

## Results (2026-03-20)
- Actual throughput: ~1700 events/sec (single-partition bottleneck)
- Consumer throughput: ~1490 events/sec
- Consumer lag at peak: 51,305 messages
- Errors: 1003/51300 (1.9% — Kafka broker backpressure at high rate)
- All 50 devices updated after backlog drained
- Max version observed: 1175

## Bottleneck Analysis
- Single Kafka partition limits producer parallelism
- Added 6 partitions — new messages distributed across all 6
- Consumer group (read-model-builder-v2) reads partition 0 only
- Fix: restart consumer after partition increase for rebalance

## Next Steps
- k6 script for BFF GraphQL (requires Auth0 M2M token)
- Cassandra time-series for higher write throughput
- Consumer group rebalance after partition increase
