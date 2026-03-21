# GrainGuard

> Production-grade, multi-tenant agri-operations SaaS platform.  
> Built as a Staff+/Principal Engineer portfolio reference system.

[![CI](https://github.com/pahuldeepp/GrainGuard-/actions/workflows/ci.yml/badge.svg)](https://github.com/pahuldeepp/GrainGuard-/actions)

---

## What is GrainGuard?

GrainGuard ingests telemetry from grain bins and field devices (temperature,
humidity, CO2), computes spoilage risk scores, and automates alert workflows.

It is deliberately architected to demonstrate end-to-end distributed systems
patterns from DDIA and Staff-level engineering practices.

---

## Architecture
```
React/Next.js Dashboard
        ↓
GraphQL Gateway (Node) — auth, rate limiting, versioning
        ↓
BFF (Node/Apollo) — resolvers, Redis cache, circuit breaker
        ↓
┌─────────────────────────────────────────┐
│  Telemetry Ingest (Go)                  │
│  Asset Registry (Go)                    │
│  Risk Engine (Python)                   │
│  Workflow Alerts (Node)                 │
│  Search Indexer (Python)                │
│  Jobs Worker (Node)                     │
└─────────────────────────────────────────┘
        ↓
Kafka (domain + CDC) — RabbitMQ (tasks)
        ↓
┌─────────────────────────────────────────┐
│  Postgres (OLTP + Outbox)               │
│  Cassandra (Time-series telemetry)      │
│  Elasticsearch (Search)                 │
│  Redis (Cache + Locks + Rate limiting)  │
│  Memcached (Volatile dashboard cache)   │
└─────────────────────────────────────────┘
```

---

## Key Engineering Patterns

| Pattern | Implementation |
|---|---|
| CQRS | Separate write (Postgres) and read (projections) models |
| Transactional Outbox | Reliable event publishing without dual-write |
| Saga Orchestration | Device provisioning with compensation |
| CDC | Debezium + Kafka Connect for Postgres WAL streaming |
| Exactly-once-ish | `processed_events` unique insert + projection UPSERT |
| Multi-tenancy | Postgres RLS + tenant-scoped queries |
| Rate limiting | Redis sliding window — 7-layer architecture |
| Cache stampede | Redis distributed lock on cache miss |
| Circuit breaker | BFF → Postgres, CLOSED/OPEN/HALF_OPEN states |
| gRPC + mTLS | Internal service communication with zero-trust mesh |

---

## Tech Stack

**Languages:** Go, TypeScript/Node, Python  
**Frontend:** React, Apollo Client, Tailwind, Storybook  
**Databases:** Postgres, Cassandra, Elasticsearch, Redis, Memcached  
**Messaging:** Kafka (KRaft), RabbitMQ, Debezium  
**Infra:** Docker, Kubernetes, Helm  
**Observability:** OpenTelemetry, Prometheus, Grafana, Loki, Tempo  
**Auth:** Auth0, JWT RS256, RBAC  
**CI/CD:** GitHub Actions  

---

## Getting Started

### Prerequisites
- Docker + Docker Compose
- Node.js 20+
- Go 1.25+
- Python 3.12+

### One-command bootstrap
```bash
bash scripts/bootstrap.sh
```

### Manual setup
```bash
# Start all infrastructure
make up

# Seed dev data
make seed

# Run tests
make test
```

### Available commands
```bash
make help
```

---

## Services

| Service | Language | Port | Description |
|---|---|---|---|
| gateway | Node | 8086 | GraphQL gateway, auth, rate limiting |
| bff | Node | 4000 | Apollo GraphQL BFF |
| dashboard | React | 5173 | Frontend UI |
| telemetry-service | Go | 50051 | gRPC telemetry ingest |
| read-model-builder | Go | - | Kafka → Postgres projections |
| saga-orchestrator | Go | - | Device provisioning saga |
| cdc-transformer | Go | - | Debezium CDC transformer |
| search-indexer | Python | - | Elasticsearch indexer |
| jobs-worker | Node | - | RabbitMQ async jobs |

---

## Observability

| Tool | URL | Purpose |
|---|---|---|
| Grafana | http://localhost:3000 | Dashboards + alerts |
| Prometheus | http://localhost:9090 | Metrics |
| Kibana | http://localhost:5601 | Elasticsearch UI |
| RabbitMQ UI | http://localhost:15672 | Queue management |
| Schema Registry | http://localhost:8082 | Protobuf schemas |

---

## Architecture Decision Records

10 ADRs documented in [`/docs/adr`](/docs/adr):

| ADR | Decision |
|---|---|
| ADR-001 | gRPC for internal service communication |
| ADR-002 | Transactional outbox over dual writes |
| ADR-003 | SAGA orchestration for device provisioning |
| ADR-004 | Cassandra TWCS for telemetry time-series |
| ADR-005 | Postgres RLS for standard-tier tenant isolation |
| ADR-006 | Redis lock with fencing tokens |
| ADR-007 | Reject cross-datastore 2PC |
| ADR-008 | Kafka KRaft over ZooKeeper |
| ADR-009 | Serializable isolation for write-skew ops |
| ADR-010 | etcd leases for singleton jobs |

---

## Load Testing Results

- **Gateway:** 1,700 events/sec, p95 5.89ms
- **Test tool:** k6 spike/soak/stress
- **Results:** [`/docs/load`](/docs/load)

---

## Project Status

| Milestone | Status |
|---|---|
| R1 — Core correctness loop | 🟡 In Progress |
| R2 — CDC + Search | ✅ Done |
| R3 — Massive scale | 🔴 Pending |
| R4 — 1B hardening | 🔴 Pending |

---

## License

Private — portfolio project.