# GrainGuard Chaos Tests

Chaos experiments using [Chaos Toolkit](https://chaostoolkit.org/) and raw `kubectl` / `kafka-topics` commands.

## Prerequisites

```bash
pip install chaostoolkit chaostoolkit-kubernetes chaostoolkit-verification
kubectl config use-context <your-cluster>
```

## Experiments

| File | Target | What it verifies |
|------|--------|-----------------|
| `pod-kill.yaml` | gateway, bff, telemetry-service | Replacement pods become ready and traffic is gated by readiness checks |
| `kafka-consumer-pause.sh` | read-model-builder, cdc-transformer | Consumer lag stays within the defined threshold after resume |
| `redis-outage.sh` | bff (cache), saga-orchestrator (lock) | GraphQL stays healthy via DB fallback and saga-orchestrator avoids panic/fatal crashes |
| `projection-lag.sh` | read-model-builder | Projection lag is detected and returns to the expected threshold after recovery |
| `network-partition.yaml` | telemetry-service → Kafka | The system recovers cleanly once connectivity is restored |

## Running

```bash
# Single experiment
chaos run tests/chaos/pod-kill.yaml

# Full suite (sequential)
bash tests/chaos/run-all.sh

# CI pipeline — see .github/workflows/chaos.yml
```

## Pass / Fail Criteria

Each experiment defines steady-state hypotheses that are verified before and after.
The experiment **fails** (non-zero exit) if any hypothesis deviates.
