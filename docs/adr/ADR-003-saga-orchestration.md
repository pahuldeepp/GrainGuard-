# ADR-003: SAGA Orchestration for Device Provisioning

## Status
Accepted

## Date
2024-03-19

## Context
Device provisioning in GrainGuard spans multiple services and datastores:
1. Create device record in telemetry-service (Postgres)
2. Publish device.created event to Kafka
3. Build device projection in read-model-builder (Postgres read)
4. Index device in Elasticsearch
5. Send welcome notification via jobs-worker (RabbitMQ)

These steps must eventually all succeed or all be compensated. A failure
at step 3 must not leave a device visible in the dashboard without telemetry.

## Decision
Use the SAGA orchestration pattern for device provisioning. A dedicated
saga-orchestrator service manages the workflow state machine, issues commands
to each service, and executes compensating transactions on failure.

## Implementation
```
State machine:
  PENDING → DEVICE_CREATED → PROJECTION_BUILT → INDEXED → COMPLETED
                    ↓               ↓              ↓
                FAILED_COMPENSATED (compensating transactions run)

Compensation:
  If PROJECTION_BUILT fails → delete device from telemetry-service
  If INDEXED fails → delete projection from read-model-builder
```

## Rationale

### Orchestration vs Choreography
Orchestration chosen over choreography for this flow because:
- Complex conditional logic (skip indexing for trial tenants)
- Visibility: saga state persisted in DB for debugging
- Recovery: orchestrator retries failed steps with backoff
- Single source of truth for workflow state

Choreography is used for simpler flows (alert escalation) where
services react independently to domain events.

### Idempotency
Every saga step is idempotent. Replaying a command produces the same
result. This is enforced via the processed_events table and unique
constraints.

## Consequences

### Positive
- Full audit trail of provisioning state in sagas table
- Recovery worker automatically retries stuck sagas
- Compensation ensures no partial device registrations
- Observable: saga state queryable for debugging

### Negative
- saga-orchestrator is a single point of coordination
- More complex than simple event chains
- Eventual consistency — device not immediately queryable

### Mitigations
- Recovery worker polls for PENDING sagas older than 5 minutes
- Saga state persisted in Postgres (survives restarts)
- Correlation IDs propagated for distributed tracing

## Alternatives Rejected

### 2PC (Two-Phase Commit)
Rejected. Blocking protocol, coordinator failure causes indefinite blocking.
See ADR-007 for full rejection rationale.

### Choreography only
Rejected for provisioning. Debugging failures across services without
central state visibility makes incident response very slow.
