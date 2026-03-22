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
| `pod-kill.yaml` | gateway, bff, telemetry-service | HPA respawns within 30s; readiness probe gates traffic |
| `kafka-consumer-pause.sh` | read-model-builder, cdc-transformer | Consumer lag ≤ 10 000 after resume; no messages lost |
| `redis-outage.sh` | bff (cache), saga-orchestrator (lock) | BFF falls back to DB; saga retries with backoff |
| `projection-lag.sh` | read-model-builder | Lag alert fires within 2 min; catches up within 5 min |
| `network-partition.yaml` | telemetry-service → Kafka | Messages buffered in producer; delivered after heal |

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
