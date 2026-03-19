# ADR-008: Kafka KRaft Mode over ZooKeeper

## Status
Accepted

## Date
2024-03-19

## Context
Kafka historically required ZooKeeper for cluster metadata management,
controller election, and configuration storage. KRaft mode (Kafka Raft
Metadata) removes this dependency, with ZooKeeper removed in Kafka 4.0.

## Decision
Use Kafka in KRaft mode (no ZooKeeper). This is the default for all
new Kafka deployments since Kafka 3.3.

## Rationale

### Operational simplicity
ZooKeeper is a separate distributed system requiring its own:
- Cluster management (minimum 3 nodes for HA)
- Monitoring and alerting
- Version compatibility matrix with Kafka
- Separate operational runbooks

Eliminating ZooKeeper removes an entire system from the operational surface.

### Faster failover
KRaft reduces controller failover time from ~30 seconds to ~1 second.
This directly improves availability during broker failures.

### Future compatibility
Apache Kafka 4.0 removes ZooKeeper entirely. Starting with KRaft avoids
a future migration.

### Managed service alignment
AWS MSK, Confluent Cloud, and Aiven all default to KRaft for new clusters.

## Consequences
### Positive
- Single system to operate instead of two
- Faster controller election
- Better aligned with cloud managed service defaults

### Negative
- KRaft was marked production-ready in Kafka 3.3 (newer than ZooKeeper)
- Some tooling (older Kafka Manager versions) not KRaft-compatible
