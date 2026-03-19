# ADR-001: gRPC for Internal Service Communication

## Status
Accepted

## Date
2024-03-19

## Context
GrainGuard requires high-throughput, low-latency communication between internal
microservices. The telemetry-service ingests IoT device readings at 2,500-3,000
events/sec sustained throughput. We evaluated three options:

1. REST/HTTP (JSON)
2. gRPC (Protobuf)
3. Kafka (async messaging)

Key requirements:
- Sub-millisecond serialization/deserialization at high volume
- Strong contract enforcement between services
- Service identity verification (zero-trust)
- Distributed tracing support

## Decision
Use gRPC with Protobuf for all synchronous internal service communication.
Kafka remains the async event backbone. REST is exposed only at the external
API gateway boundary.

## Rationale

### Performance
Protobuf binary serialization is 3-10x smaller than JSON and 5-7x faster to
serialize/deserialize. At 3,000 events/sec this compounds significantly.

### Contract enforcement
Proto IDL enforces schema at compile time. Breaking changes are caught before
deployment. JSON has no equivalent compile-time guarantee.

### Service mesh compatibility
gRPC integrates natively with Istio/Linkerd for mTLS, circuit breaking, and
distributed tracing via OpenTelemetry interceptors.

### Developer experience
Generated client/server stubs eliminate hand-written HTTP clients. Proto
evolution rules (add-only, never renumber) provide safe versioning.

## Consequences

### Positive
- Binary protocol reduces serialization overhead at scale
- mTLS enforced at transport layer (TLS 1.3 minimum)
- OTel interceptors provide automatic span propagation
- Proto contracts versioned in Schema Registry

### Negative
- Harder to debug than REST (no curl without grpcurl)
- Requires proto compiler in build pipeline
- Learning curve for engineers unfamiliar with Protobuf

### Mitigations
- gRPC-Gateway generates REST bridge for external partners
- grpcurl available in developer toolchain
- Proto files documented in /libs/events/proto/

## Alternatives Rejected

### REST/JSON
Rejected due to serialization overhead at target throughput. JSON parsing
at 3,000 req/sec adds measurable CPU overhead. Also lacks compile-time
contract enforcement.

### Pure Kafka for all communication
Rejected for synchronous request/response patterns. Kafka adds unnecessary
latency for operations requiring immediate responses (device provisioning,
health checks).

## References
- gRPC performance benchmarks: https://grpc.io/docs/guides/benchmarking/
- Proto style guide: https://protobuf.dev/programming-guides/style/
- ADR-007: Rejection of cross-datastore 2PC
