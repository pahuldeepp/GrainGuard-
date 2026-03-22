# GrainGuard

> Staff+/Principal-grade, polyglot microservices SaaS platform for grain and agri operations.

GrainGuard ingests high-volume device telemetry, computes spoilage risk scores, triggers automated alert workflows, and ships with full security, observability, CI/CD, and failure-recovery playbooks. Deliberately architected to demonstrate end-to-end DDIA patterns and Staff-level engineering depth.

---

## Architecture
```
React Dashboard
      ↓
API Gateway (Node) -- JWT/RBAC/Rate Limiting
      ↓
BFF GraphQL (Node) -- Redis Cache -- Elasticsearch
      ↓
Telemetry Service (Go, gRPC + mTLS)
      ↓
Postgres (OLTP + Outbox) -- Kafka (CDC via Debezium)
      ↓
Read Model Builder (Go) -- Cassandra (time-series) -- Postgres Read
      ↓
Risk Engine (Python) -- Workflow Alerts (Node) -- RabbitMQ -- Jobs Worker
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

**Infrastructure:** Docker Compose · Kubernetes · Terraform (AWS EKS/RDS/MSK/Elasticache)

**Security:** Auth0 · JWT/RBAC · mTLS · Postgres RLS · Audit logging · Helmet/CORS

---

## Running locally

### Prerequisites
- Docker + Docker Compose
- Go 1.25+
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

### Run replay test
```bash
./scripts/replay/replay_test.sh
```

---

## Testing
```bash
# Go unit + integration tests
go test ./...

# React unit tests
cd apps/dashboard && npm test

# k6 load tests
k6 run scripts/load-tests/gateway-load-test.js

# Replay + idempotency test
./scripts/replay/replay_test.sh
```

---

## Observability

- **Traces:** Grafana Tempo via OpenTelemetry
- **Metrics:** Prometheus + Grafana (gateway, BFF, read-model-builder)
- **Logs:** Loki structured JSON logs across all Go services
- **Alerts:** 5 Grafana alert rules to Slack #grainguard-alerts
  - Service down
  - High error rate (>10% 5xx)
  - Kafka consumer lag (>10k messages)
  - DLQ messages detected
  - Critical spoilage risk

---

## Infrastructure (AWS)
```bash
cd infra/terraform/environments/dev
terraform init
terraform plan -var="db_password=yourpassword"
terraform apply -var="db_password=yourpassword"
```

Provisions: VPC · EKS · RDS Postgres · Elasticache Redis · MSK Kafka

---

## Architecture Decision Records

| ADR | Decision |
|-----|----------|
| ADR-001 | gRPC for internal service communication |
| ADR-002 | Transactional outbox over dual writes |
| ADR-003 | SAGA orchestration for device provisioning |
| ADR-004 | Cassandra TWCS for telemetry time-series |
| ADR-005 | Postgres RLS for tenant isolation |
| ADR-006 | Redis locks + etcd for leadership |
| ADR-007 | Reject cross-datastore 2PC |
| ADR-008 | Kafka KRaft over ZooKeeper |
| ADR-009 | Serializable isolation for write-skew ops |
| ADR-010 | etcd leases for singleton job leader election |

---

## Roadmap

| Release | Goal | Status |
|---------|------|--------|
| R1 | Core correctness loop | ~85% done |
| R2 | CDC + Search + Messaging | ~80% done |
| R3 | Scale hardening | ~30% done |
| R4 | 1B-user hardening | ~10% done |

---

## Load test results

- Kafka ingest: **1,700 events/sec**
- Gateway p95 latency: **5.89ms**
- Read model builder: **2,500-3,000 events/sec** sustained

---

*Built as a Staff+/Principal Engineer portfolio reference.*
