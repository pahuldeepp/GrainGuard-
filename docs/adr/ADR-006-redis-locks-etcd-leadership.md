# ADR-006: Redis Locks with Fencing Tokens; etcd for Strong Leadership

## Status
Accepted

## Date
2024-03-19

## Context
GrainGuard requires distributed coordination for two distinct use cases:

1. **Short-lived locks**: Prevent cache stampede, deduplicate concurrent
   writes, protect critical sections (outbox worker, saga steps)

2. **Singleton leadership**: Ensure exactly one instance of the outbox worker,
   recovery worker, and scheduled jobs runs at any time

These have different correctness requirements.

## Decision
- Redis SET NX PX with fencing tokens for short-lived distributed locks
- etcd leases for singleton job leadership election (Phase 4)

## Redis lock implementation
```go
// Acquire lock with fencing token
token := uuid.New().String()
ok := redis.SetNX(ctx, lockKey, token, ttl)

// Fencing token prevents stale lock holder from writing:
// Lock holder passes token with every write
// Storage system rejects writes with outdated tokens
```

## Rationale

### Why not Redlock?
Redlock (multi-node Redis consensus) provides stronger guarantees but requires
odd number of independent Redis nodes. For GrainGuard's current scale, single
Redis instance with fencing tokens provides sufficient safety.

### Why etcd for leadership?
etcd uses Raft consensus — genuinely linearizable. Redis distributed locks
are not safe under network partition (asynchronous model). For singleton jobs
where dual execution causes data corruption, etcd's stronger guarantee justifies
the operational overhead.

## Consequences
### Positive
- Redis locks are fast (<1ms) for high-frequency coordination
- etcd provides provably correct leader election for critical singletons
- Fencing tokens prevent split-brain writes

### Negative
- etcd adds operational dependency (Phase 4)
- Redis single-node is a single point of failure for locks

## Memcached
Deferred to R3. At 1B-user scale, Redis coordination work (locks, rate limiting, pub/sub, saga state) justifies offloading volatile dashboard reads to a dedicated Memcached tier. Not warranted at current traffic.
