# ADR-002: Transactional Outbox over Dual Writes

## Status
Accepted

## Date
2024-03-19

## Context
GrainGuard must reliably publish domain events to Kafka whenever a write
occurs in Postgres. The naive approach is dual-write: write to DB and publish
to Kafka in sequence. This is fundamentally broken under failure conditions.

Failure scenario with dual-write:
1. Write to Postgres succeeds
2. Process crashes before Kafka publish
3. Event is permanently lost
4. Read model never updated
5. Dashboard shows stale data

## Decision
Use the transactional outbox pattern. Every domain write atomically inserts
an event into an outbox table within the same Postgres transaction. A separate
outbox worker reads unpublished events and publishes them to Kafka.

## Implementation
```
BEGIN TRANSACTION
  INSERT INTO devices (id, tenant_id, serial_number) VALUES (...)
  INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    VALUES ('device', $id, 'device.created', $protobuf_bytes)
COMMIT

-- Outbox worker (separate process):
SELECT * FROM outbox_events WHERE published = false ORDER BY created_at
FOR UPDATE SKIP LOCKED
→ publish to Kafka
→ mark published = true
```

## Rationale

### Atomicity
The device write and event insertion share the same ACID transaction. Either
both succeed or both fail. No partial states possible.

### At-least-once delivery
If the outbox worker crashes after publishing but before marking published,
the event will be republished. Consumers handle this via the processed_events
idempotency table (ADR-007).

### Decoupling
The telemetry service has no direct Kafka dependency. It writes to Postgres
only. The outbox worker handles Kafka independently. Services can be deployed
and scaled independently.

## Consequences

### Positive
- Zero event loss under any failure condition
- Atomic write + publish guarantee
- Services decoupled from Kafka availability
- Replay possible from outbox table

### Negative
- Additional outbox table per write service
- Outbox worker adds operational complexity
- Slight latency increase (outbox polling interval)

### Mitigations
- SKIP LOCKED ensures multiple outbox workers don't process same event
- Polling interval tunable (currently 100ms)
- Dead letter handling for unpublishable events

## Alternatives Rejected

### Dual Write
Rejected. Not safe under any crash scenario between the two writes.
Impossible to make atomic across two different systems.

### Kafka Transactions (exactly-once)
Considered but rejected. Requires Kafka transactional producers which add
complexity and latency. Outbox + idempotent consumers achieves equivalent
correctness with simpler infrastructure.

### Change Data Capture only
Partially adopted (Debezium CDC for telemetry_readings). CDC is used for
high-volume telemetry CDC pipeline. Outbox is used for domain events requiring
rich event payloads.

## References
- Microservices Patterns (Chris Richardson): Outbox pattern
- Debezium outbox event router
