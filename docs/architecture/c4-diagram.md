# GrainGuard — C4 Architecture Diagram

## Level 1: System Context
```
+------------------+         +------------------------+
|                  |         |                        |
|   Farm Operator  +-------->+      GrainGuard        |
|                  |  views  |                        |
+------------------+  alerts |  Multi-tenant SaaS     |
                     data    |  for grain operations  |
+------------------+         |                        |
|                  +-------->+                        |
|  Admin / Manager |  manages+------------------------+
|                  |  tenants         |
+------------------+                 |
                                      | sends alerts
+------------------+         +--------v---------------+
|                  |         |                        |
|  IoT Devices /   +-------->+   External Services    |
|  Grain Sensors   | telemetry| Auth0, SendGrid,      |
|                  |         | Slack, Stripe (R3)     |
+------------------+         +------------------------+
```

---

## Level 2: Container Diagram
```
+----------------------------------------------------------+
|                        GrainGuard                        |
|                                                          |
|  +----------------+      +---------------------------+  |
|  |   Dashboard    |      |      API Gateway          |  |
|  |  React/Vite    +----->+  Node.js                  |  |
|  |  Tailwind CSS  |      |  JWT/RBAC/Rate limiting   |  |
|  |  Apollo Client |      |  Helmet/CORS              |  |
|  +----------------+      +----------+----------------+  |
|                                     |                    |
|                          +----------v----------------+  |
|                          |         BFF               |  |
|                          |  Node.js / Apollo Server  |  |
|                          |  GraphQL + Subscriptions  |  |
|                          |  Redis cache-aside        |  |
|                          |  Elasticsearch search     |  |
|                          +----------+----------------+  |
|                                     |  gRPC + mTLS       |
|                          +----------v----------------+  |
|                          |   Telemetry Service       |  |
|                          |  Go / gRPC                |  |
|                          |  RBAC interceptors        |  |
|                          |  Transactional outbox     |  |
|                          +----------+----------------+  |
|                                     |                    |
+----------------------------------------------------------+
                                      |
              +-----------------------+-----------------------+
              |                       |                       |
   +----------v-------+   +-----------v------+   +-----------v------+
   |     Postgres      |   |      Kafka       |   |      Redis       |
   |  OLTP + Outbox    |   |  KRaft, CDC      |   |  Cache + Locks   |
   |  Write model      |   |  Event backbone  |   |  Rate limiting   |
   +-------------------+   +------------------+   +------------------+
              |                       |
   +----------v-------+   +-----------v------+
   |  Postgres Read    |   |  Kafka Consumers |
   |  CQRS projections |   |                  |
   |  RLS tenant iso.  |   | +-------------+  |
   +-------------------+   | |Read Model   |  |
                            | |Builder (Go) |  |
   +-------------------+   | +-------------+  |
   |    Cassandra       |   | |CDC Transform|  |
   |  Time-series       |   | +-------------+  |
   |  TWCS + TTL        |<--+ |Search Index |  |
   +-------------------+   | +-------------+  |
                            | |Risk Engine  |  |
   +-------------------+   | |(Python)     |  |
   |  Elasticsearch    |<--+ +-------------+  |
   |  Full-text search |   +------------------+
   |  Fuzzy + tenant   |              |
   +-------------------+   +----------v------+
                            |    RabbitMQ     |
                            |  Async tasks    |
                            |  DLQ + retries  |
                            +----------+------+
                                       |
                            +----------v------+
                            |   Jobs Worker   |
                            |  Node.js        |
                            |  Email/Webhook  |
                            |  Export/Alert   |
                            +-----------------+
```

---

## Level 3: Component Diagram — Telemetry Ingest Pipeline
```
IoT Device
    |
    | gRPC (mTLS)
    v
+---+------------------+
|  Telemetry Service   |
|                      |
|  JWT interceptor     |
|  RBAC interceptor    |
|  OTel tracing        |
|                      |
|  CreateDevice -----> device_projections (Postgres)
|  RecordTelemetry --> telemetry_readings (Postgres)
|                      |
|  Outbox worker -----> outbox table
+---+------------------+
    |
    | Debezium CDC (WAL)
    v
+---+------------------+
|  Kafka Connect       |
|  Debezium connector  |
|  grainguard.public.  |
|  telemetry_readings  |
+---+------------------+
    |
    | CDC events
    v
+---+------------------+
|  CDC Transformer     |
|  Go                  |
|  Debezium envelope   |
|  --> domain events   |
+---+------------------+
    |
    | telemetry.events
    v
+---+------------------+     +------------------+
|  Read Model Builder  |     |  Cassandra Writer |
|  Go                  |     |  Go               |
|  Batch consumer      |     |  Time-series      |
|  64x fewer DB calls  |     |  TWCS + TTL       |
|  Idempotency check   |     +------------------+
|  RLS projections     |
+---+------------------+
    |
    | risk.scores
    v
+---+------------------+
|  Risk Engine         |
|  Python              |
|  Temperature +       |
|  Humidity scoring    |
|  0.0 - 1.0 score     |
+---+------------------+
    |
    | warn/critical
    v
+---+------------------+
|  Workflow Alerts     |
|  Node.js             |
|  5min dedup cooldown |
|  RabbitMQ publish    |
+---+------------------+
    |
    v
+---+------------------+
|  Jobs Worker         |
|  Node.js             |
|  Email/Webhook       |
|  Jitter retry + DLQ  |
+---+------------------+
```

---

## Level 3: Component Diagram — Device Provisioning Saga
```
device_created_v1 (Kafka: device.events)
        |
        v
+-------+------------+
|  Saga Orchestrator  |
|  Go                 |
|  ProvisionSaga      |
|  Postgres state     |
|  Recovery worker    |
+-------+------------+
        |
        | tenant.attach_device (device.commands)
        v
+-------+------------+
|  Asset Registry     |
|  Go                 |
|  Command consumer   |
|  Event publisher    |
+-------+------------+
        |
        | tenant_attached_v1 (device.events)
        v
+-------+------------+
|  Saga Orchestrator  |
|  quota.allocate     |
+-------+------------+
        |
        | quota_allocated_v1
        v
   SAGA COMPLETED
   (or compensation
    flow on failure)
```

---

## Data Store Responsibilities

| Store | Workload | Why |
|-------|----------|-----|
| Postgres (write) | OLTP + outbox | ACID transactions, constraints |
| Postgres (read) | CQRS projections | Fast reads, RLS tenant isolation |
| Cassandra | Time-series telemetry | High write QPS, TWCS, TTL |
| Redis | Locks, rate limits, cache | Coordination + volatile caching |
| Elasticsearch | Full-text search | Fuzzy matching, aggregations |
| Kafka | Event backbone | Durable streams, replay, CDC |
| RabbitMQ | Async task queue | Delayed retries, DLQ isolation |

---

## Security Boundary
```
Internet
    |
    | HTTPS
    v
[Auth0] --> JWT tokens
    |
    v
API Gateway (rate limit, JWT verify, RBAC)
    |
    | Internal network only
    v
BFF <--> Telemetry Service (gRPC + mTLS)
    |
    v
Postgres RLS (tenant_id enforced at DB level)
    |
Audit log stream (immutable, append-only)
```
