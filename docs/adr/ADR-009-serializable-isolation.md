# ADR-009: Serializable Isolation for Write-Skew-Sensitive Operations

## Status
Accepted

## Date
2024-03-19

## Context
Most GrainGuard operations use READ COMMITTED isolation (Postgres default).
However, certain operations are sensitive to write skew — a phenomenon where
two concurrent transactions each read a consistent snapshot, make decisions
based on that snapshot, and write conflicting results.

Write-skew example in GrainGuard:
- Transaction A: reads tenant quota (80/100 devices used), decides to add device
- Transaction B: reads tenant quota (80/100 devices used), decides to add device
- Both commit: tenant now has 102 devices (quota exceeded)

## Decision
Use SERIALIZABLE isolation for quota enforcement and other write-skew-sensitive
operations. Use SELECT FOR UPDATE for explicit row locking where appropriate.

## Implementation
```go
// Quota enforcement with serializable isolation
tx, err := pool.BeginTx(ctx, pgx.TxOptions{
    IsoLevel: pgx.Serializable,
})
// Any concurrent transaction that could cause write skew will fail
// with serialization failure — retry logic handles this
```

## Operations requiring serializable isolation
- Tenant device quota enforcement
- Billing usage metering
- API key uniqueness enforcement
- Rate limit counter updates (use Redis instead — see below)

## Operations using READ COMMITTED (default)
- Telemetry reads (eventual consistency acceptable)
- Device list queries
- Historical telemetry queries

## Operations using SELECT FOR UPDATE
- Outbox worker (SKIP LOCKED for fair queue processing)
- Saga state transitions

## Consequences
### Positive
- Prevents quota exceeded race conditions
- Correct billing (no over/under counting)
- Postgres SSI implementation has low overhead for low-contention cases

### Negative
- Serialization failures require retry logic
- Higher latency for quota-sensitive operations
- More complex transaction management code
