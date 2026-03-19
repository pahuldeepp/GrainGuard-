# ADR-010: etcd Leases for Singleton Job Leader Election

## Status
Accepted (planned for Phase 4 implementation)

## Date
2024-03-19

## Context
Several GrainGuard background jobs must run as singletons — exactly one
instance across all replicas at any time:

- Outbox worker (publishing domain events to Kafka)
- Saga recovery worker (retrying stuck sagas)
- Scheduled telemetry aggregation jobs
- Database maintenance tasks

Running multiple instances causes:
- Duplicate event publishing (outbox)
- Duplicate saga retry attempts
- Duplicate scheduled job execution
- Data corruption in worst case

## Decision
Use etcd leases for leader election of singleton jobs. The instance holding
the lease is the active leader. All others are standbys. On leader failure
(crash, network partition), etcd lease expires and a standby wins election.

## Implementation
```go
// Leader election using etcd lease
cli, _ := clientv3.New(clientv3.Config{Endpoints: []string{"etcd:2379"}})
sess, _ := concurrency.NewSession(cli, concurrency.WithTTL(10))
election := concurrency.NewElection(sess, "/grainguard/leaders/outbox-worker")

// Blocks until this instance becomes leader
election.Campaign(ctx, nodeID)

// Run singleton job
runOutboxWorker(ctx)

// On context cancellation (shutdown):
election.Resign(ctx)
```

## Rationale

### Why not Redis SETNX?
Redis distributed locks are not safe under network partition in the
asynchronous model. A lock holder that is paused (GC, network delay) can
hold an expired lock while another instance acquires it — dual leaders.

For singleton jobs where dual execution causes data corruption, Redis
does not provide sufficient safety guarantees.

### Why etcd?
etcd uses Raft consensus — provides linearizable reads and writes.
Leader election is built into the etcd client library. Lease TTL ensures
dead leaders are evicted within a bounded time window.

### Fencing tokens
Even with etcd, the leader passes an epoch/term number with writes.
Storage systems reject writes from stale leaders (lower epoch).

## Consequences
### Positive
- Provably correct leader election (linearizable)
- Built-in lease expiry handles dead leaders automatically
- Standard pattern used by Kubernetes, etcd-operator, etc.

### Negative
- etcd adds operational dependency
- etcd cluster requires odd number of nodes for HA (3 or 5)
- Additional latency for leadership acquisition on startup

### Mitigations
- AWS offers managed etcd via EKS control plane
- Leadership acquisition typically completes in <100ms
- Standby instances remain warm (connected, just not executing)

## References
- etcd leader election documentation
- Raft consensus algorithm (Ongaro & Ousterhout, 2014)
- DDIA Chapter 9: Consistency and consensus
