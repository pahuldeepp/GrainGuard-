# ADR-007: Reject Cross-Datastore 2PC; Use Outbox + Idempotency

## Status
Accepted

## Date
2024-03-19

## Context
Device provisioning writes to both Postgres and triggers Kafka events. The
question arose: should we use Two-Phase Commit (2PC) to coordinate atomically
across datastores?

## Decision
Explicitly reject cross-datastore 2PC. Use transactional outbox (ADR-002)
plus idempotent consumers as the correctness mechanism.

## Rationale

### 2PC failure modes
2PC requires a coordinator. If the coordinator fails after Phase 1 (prepare)
but before Phase 2 (commit), all participants are blocked indefinitely waiting
for the coordinator to recover. This is the fundamental problem with 2PC:
**blocking under coordinator failure**.

In a distributed system with network partitions, this blocking is unacceptable.

### Outbox + idempotency is equivalent
The outbox pattern provides at-least-once delivery. Idempotent consumers
(processed_events table with unique constraint) handle duplicate delivery.
The combination achieves exactly-once semantics without 2PC's blocking problem.
```
At-least-once delivery + idempotent processing = effectively exactly-once
```

## Consequences
### Positive
- No blocking under any failure condition
- Simpler infrastructure (no distributed transaction coordinator)
- Each service owns its own transaction boundary

### Negative
- Eventual consistency — consumers see events with delay
- Requires idempotency implementation in every consumer
- More complex failure analysis (must reason about at-least-once)

## Note on 2PC knowledge
While 2PC is rejected for cross-datastore writes, understanding 2PC is
important for interviews and for understanding why distributed databases
like CockroachDB and Google Spanner make different trade-offs.
