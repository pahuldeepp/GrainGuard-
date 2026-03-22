# GrainGuard

> Staff+/Principal-grade, polyglot microservices SaaS platform for grain and agri operations.

GrainGuard ingests high-volume device telemetry, computes spoilage risk scores, triggers automated alert workflows, and ships with full security, observability, CI/CD, chaos testing, SLO monitoring, and operational runbooks. Deliberately architected to demonstrate end-to-end DDIA patterns and Staff-level engineering depth.

---

## Architecture

```
React Dashboard
      ↓
API Gateway (Node) ── JWT/RBAC/Rate Limiting
      ↓
BFF GraphQL (Node) ── Redis Cache ── Elasticsearch
      ↓
Telemetry Service (Go, gRPC + mTLS)
      ↓
Postgres (OLTP + Outbox) ── Kafka (CDC via Debezium)
      ↓
Read Model Builder (Go) ── Cassandra (time-series) ── Postgres Read
      ↓
Risk Engine (Python) ── Workflow Alerts (Node) ── RabbitMQ ── Jobs Worker
```

### Key design decisions

| Concern | Decision | Why |
|---------|----------|-----|
| Write model | Postgres + transactional outbox | ACID + safe event publishing |
| Read model | CQRS projections + materialized views | Fast reads, explicit eventual consistency |
| Time-series | Cassandra (TWCS + TTL) | High write throughput, predictable access |
| Event backbone | Kafka (KRaft) | Durable streams, replay, CDC integration |
| Async tasks | RabbitMQ | Delayed retries, DLQ, isolated from Kafka |
| Caching | Redis | Locks, rate limiting, cache-aside, pub/sub |
| Search | Elasticsearch | Full-text, fuzzy, tenant-scoped |
| Inter-service | gRPC + Protobuf + mTLS | Type-safe, zero-trust internal comms |
| Multi-tenancy | Postgres RLS | Row-level isolation per tenant |
| Auth | Auth0 + JWT + RBAC | OAuth2/OIDC for humans, API keys for devices |

---

## Services

| Service | Language | Responsibility |
|---------|----------|----------------|
| `gateway` | Node.js | JWT auth, rate limiting, gRPC proxy |
| `bff` | Node.js | GraphQL API, Redis cache, subscriptions |
| `telemetry-service` | Go | gRPC ingest, outbox publishing |
| `read-model-builder` | Go | Kafka consumer, CQRS projections |
| `cdc-transformer` | Go | Debezium CDC to domain events |
| `saga-orchestrator` | Go | Device provisioning saga + compensation |
| `asset-registry` | Go | Device/site commands, saga event responses |
| `risk-engine` | Python | Spoilage scoring from telemetry |
| `workflow-alerts` | Node.js | Alert rules, deduplication, RabbitMQ trigger |
| `jobs-worker` | Node.js | Email/webhook/export handlers + DLQ |
| `search-indexer` | Python | Elasticsearch indexing from Kafka |
| `cassandra-writer` | Go | Time-series telemetry to Cassandra |
| `dlq-reprocessor` | Go | Dead letter queue replay |

---

## Tech Stack

**Data stores:** Postgres · Cassandra · Redis · Elasticsearch

**Messaging:** Kafka (KRaft) · RabbitMQ · Debezium CDC

**Observability:** Prometheus · Grafana · Loki · Tempo · OpenTelemetry

**Infrastructure:** Docker Compose · Kubernetes (Helm + ArgoCD) · Terraform (AWS EKS/RDS/MSK/Elasticache)

**Security:** Auth0 · JWT/RBAC · mTLS · Postgres RLS · Audit logging · Helmet/CORS

---

## Running locally

### Prerequisites
- Docker + Docker Compose
- Go 1.24+
- Node.js 20+
- Python 3.12+

### Start all services
```bash
cd infra/docker
docker compose --env-file .env up -d
```

### Environment variables
```bash
cp infra/docker/.env.example infra/docker/.env
```

| Variable | Description |
|----------|-------------|
| `SLACK_WEBHOOK_URL` | Slack webhook for Grafana alerts |

### Service endpoints

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:5173 |
| Gateway | http://localhost:8086 |
| BFF GraphQL | http://localhost:4000/graphql |
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Kibana | http://localhost:5601 |
| RabbitMQ UI | http://localhost:15672 |
| Kafka Connect | http://localhost:8083 |

### Publish test telemetry
```bash
go run tools/publish-telemetry/main.go
```

---

## Testing

```bash
# Go unit + integration tests
go test -race -count=1 ./...

# k6 load tests (requires running stack)
k6 run tests/load/spike.js
k6 run tests/load/soak.js
k6 run tests/load/stress.js

# Chaos tests (requires kubectl + live cluster)
bash tests/chaos/run-all.sh

# Replay + idempotency test
./scripts/replay/replay_test.sh
```

---

## Observability

- **Traces:** Grafana Tempo via OpenTelemetry
- **Metrics:** Prometheus + Grafana (gateway, BFF, read-model-builder)
- **Logs:** Loki structured JSON logs across all Go services
- **SLOs:** Burn-rate alerts (availability 99.9%, latency p95 < 500ms, p99 < 1000ms)
- **Alerts:**
  - `AvailabilitySLOFastBurn` — error budget burning at 14.4x (critical, pages immediately)
  - `AvailabilitySLOMediumBurn` — error budget burning at 6x (warning)
  - `LatencySLOP95Breach` / `LatencySLOP99Breach` — latency SLO breach
  - `ProjectionLagHigh` / `ProjectionLagCritical` — consumer lag SLO breach
  - `DLQMessagesAccumulating` — dead letter queue spike

---

## Chaos Testing

Five experiments covering the critical failure modes:

| Experiment | What it kills | Pass condition |
|------------|--------------|----------------|
| `pod-kill` | gateway, bff, telemetry-service pods | Respawns within 30s |
| `kafka-consumer-pause` | read-model-builder + cdc-transformer | Lag ≤ 10 000 within 5 min |
| `redis-outage` | Redis | BFF falls back to DB, no panics |
| `projection-lag` | read-model-builder | Alert fires, lag recovers in 5 min |
| `network-partition` | telemetry-service → Kafka egress | Messages buffered, delivered after heal |

```bash
# Run all experiments
bash tests/chaos/run-all.sh

# Or trigger via GitHub Actions (manual dispatch)
# .github/workflows/chaos.yml — also runs weekly on Saturdays
```

---

## Operational Runbooks

On-call guides for every critical failure mode:

| Runbook | Trigger |
|---------|---------|
| [Postgres Failover](docs/runbooks/postgres-failover.md) | Primary down, replica lag high |
| [Kafka Loss](docs/runbooks/kafka-loss.md) | Broker down, under-replicated partitions |
| [DLQ Spike](docs/runbooks/dlq-spike.md) | `DLQMessagesAccumulating` alert |
| [Redis Failover](docs/runbooks/redis-failover.md) | Cache miss 100%, lock timeouts |
| [Projection Lag](docs/runbooks/projection-lag.md) | `ProjectionLagHigh` alert |
| [gRPC Outage](docs/runbooks/grpc-outage.md) | Circuit breaker open, 503 upstream |

---

## Infrastructure (AWS)

```bash
cd infra/terraform/environments/dev
terraform init
terraform plan -var="db_password=yourpassword"
terraform apply -var="db_password=yourpassword"
```

Provisions: VPC · EKS · RDS Postgres · Elasticache Redis · MSK Kafka · DynamoDB · ECR · Secrets Manager

---

## Kubernetes (GitOps)

```bash
# Bootstrap ArgoCD and deploy all services
bash k8s/argocd/install.sh

# Helm — render and diff before ArgoCD picks it up
helm diff upgrade grainguard k8s/helm/grainguard \
  -f k8s/helm/grainguard/values.yaml \
  -f k8s/helm/grainguard/values-dev.yaml \
  -n grainguard-dev
```

ArgoCD watches `k8s/argocd/apps/` and auto-syncs on every push to master.

---

## Architecture Decision Records

| ADR | Decision |
|-----|----------|
| ADR-001 | gRPC for internal service communication |
| ADR-002 | Transactional outbox over dual writes |
| ADR-003 | SAGA orchestration for device provisioning |
| ADR-004 | Cassandra TWCS for telemetry time-series |
| ADR-005 | Postgres RLS for tenant isolation |
| ADR-006 | Redis locks for distributed coordination |
| ADR-007 | Reject cross-datastore 2PC |
| ADR-008 | Kafka KRaft over ZooKeeper |
| ADR-009 | Serializable isolation for write-skew ops |
| ADR-010 | Multi-window burn-rate SLOs (Google SRE model) |

---

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| R1 — Core loop | Ingest, CQRS, outbox, saga | ✅ Done |
| R2 — CDC + Search | Debezium, Elasticsearch, RabbitMQ | ✅ Done |
| R3 — Reliability | Helm, ArgoCD, k6 load tests, chaos tests | ✅ Done |
| R4 — Observability | SLOs, burn-rate alerts, Grafana dashboard, runbooks | ✅ Done |
| R5 — Security | CSRF, CSP, Trivy, CodeQL, SBOM, STRIDE | 🔜 Next |
| R6 — SaaS billing | Stripe, tenant onboarding, usage metering | 🔜 Planned |

---

## Load test results

- Kafka ingest: **1,700 events/sec**
- Gateway p95 latency: **5.89ms**
- Read model builder: **2,500–3,000 events/sec** sustained

---

*Built as a Staff+/Principal Engineer portfolio reference — demonstrating DDIA patterns, distributed systems, GitOps, SRE practices, and multi-tenant SaaS architecture.*
