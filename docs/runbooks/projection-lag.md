# Runbook: Projection Lag

**Alert:** `ProjectionLagHigh` (>5 000) / `ProjectionLagCritical` (>50 000)
**Severity:** Warning → Critical
**Service affected:** read-model-builder, cdc-transformer

---

## Symptoms
- Device dashboard showing stale data
- `kafka_consumergroup_lag` metric rising continuously
- Read model builder pod CPU/memory spiking or pod restarting

---

## Diagnosis

```bash
# 1. Current lag per partition
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group read-model-builder

# 2. Is the consumer pod healthy?
kubectl get pods -n grainguard-dev -l app=read-model-builder
kubectl logs -n grainguard-dev deploy/read-model-builder --since=10m \
  | tail -50

# 3. Check for OOMKill
kubectl describe pod -n grainguard-dev -l app=read-model-builder \
  | grep -A5 "Last State"

# 4. Check Postgres write throughput (is DB the bottleneck?)
kubectl exec -n grainguard-dev deploy/postgres -- \
  psql -U grainguard -c "
    SELECT schemaname, relname, n_tup_ins, n_tup_upd
    FROM pg_stat_user_tables
    WHERE relname IN ('telemetry_latest', 'device_read_model')
    ORDER BY n_tup_upd DESC;"

# 5. Check partition count vs consumer count
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-topics.sh --bootstrap-server kafka:9092 \
  --describe --topic telemetry.events | grep PartitionCount
```

---

## Fix — Consumer is healthy but slow (scale out)

```bash
# Scale read-model-builder (max = partition count on telemetry.events)
kubectl scale deployment/read-model-builder \
  -n grainguard-dev --replicas=3

# Monitor lag dropping
watch -n5 'kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group read-model-builder'
```

---

## Fix — Consumer pod OOMKilled

```bash
# Increase memory limit temporarily
kubectl set resources deployment/read-model-builder \
  -n grainguard-dev \
  --limits=memory=1Gi --requests=memory=512Mi

kubectl rollout status deployment/read-model-builder \
  -n grainguard-dev --timeout=60s
```

---

## Fix — Consumer crashed on bad message (poison pill)

```bash
# Find the offset of the bad message from logs
kubectl logs -n grainguard-dev deploy/read-model-builder --since=30m \
  | grep -i "error\|panic\|unmarshal"

# Skip past the bad message (shift offset by 1)
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --group read-model-builder \
  --topic telemetry.events \
  --reset-offsets --shift-by 1 --execute

kubectl rollout restart deployment/read-model-builder -n grainguard-dev
```

---

## Verify recovery

```bash
# Lag should be dropping toward 0
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group read-model-builder

# Dashboard data should be fresh (check updatedAt field)
curl -s -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_JWT" \
  -d '{"query":"{ deviceTelemetry(deviceId:\"test-device\") { updatedAt } }"}' \
  | jq .
```

---

## Escalate if
- Lag not dropping after scaling to max partitions
- Postgres write latency > 1s (DB is the bottleneck, not consumer)
- Bad messages keep appearing after offset skip (upstream schema bug)
