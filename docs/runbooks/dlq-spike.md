# Runbook: DLQ Spike

**Alert:** `DLQMessagesAccumulating`
**Severity:** Warning
**Service affected:** dlq-reprocessor, telemetry-service, cdc-transformer

---

## Symptoms
- `kafka_topic_partition_current_offset` increasing on `*.dlq` topics
- dlq-reprocessor logs showing repeated failures
- Telemetry data missing from read models for specific devices

---

## Diagnosis

```bash
# 1. How many messages are in the DLQ?
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-run-class.sh kafka.tools.GetOffsetShell \
  --broker-list kafka:9092 --topic telemetry.events.dlq

# 2. Inspect the first few DLQ messages
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 \
  --topic telemetry.events.dlq \
  --from-beginning --max-messages 5 \
  --property print.key=true

# 3. Check dlq-reprocessor logs for the error pattern
kubectl logs -n grainguard-dev deploy/dlq-reprocessor --since=30m \
  | grep -i "error\|failed\|retry"

# 4. Check if it's a schema issue
kubectl logs -n grainguard-dev deploy/cdc-transformer --since=30m \
  | grep -i "schema\|parse\|unmarshal"
```

---

## Fix — Schema validation error (malformed payload)

```bash
# 1. Identify the bad device IDs from DLQ messages (from diagnosis step 2)

# 2. If payload is genuinely malformed, skip those messages
# Move DLQ offset forward past the bad batch
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --group dlq-reprocessor \
  --topic telemetry.events.dlq \
  --reset-offsets --shift-by 10 --execute

# 3. Restart dlq-reprocessor
kubectl rollout restart deployment/dlq-reprocessor -n grainguard-dev
```

---

## Fix — Downstream dependency down (Postgres/Redis)

```bash
# If DLQ messages are failing because Postgres is down,
# pause dlq-reprocessor until DB is healthy
kubectl scale deployment/dlq-reprocessor -n grainguard-dev --replicas=0

# Fix the upstream issue (see postgres-failover.md or redis-failover.md)

# Then resume
kubectl scale deployment/dlq-reprocessor -n grainguard-dev --replicas=1
```

---

## Fix — Retry all DLQ messages after root cause fixed

```bash
# Reset DLQ consumer to beginning to replay all messages
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --group dlq-reprocessor \
  --topic telemetry.events.dlq \
  --reset-offsets --to-earliest --execute

kubectl rollout restart deployment/dlq-reprocessor -n grainguard-dev
```

---

## Verify recovery

```bash
# DLQ offset should stop growing
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-run-class.sh kafka.tools.GetOffsetShell \
  --broker-list kafka:9092 --topic telemetry.events.dlq

# dlq-reprocessor logs should show successful processing
kubectl logs -n grainguard-dev deploy/dlq-reprocessor --since=5m \
  | grep -i "processed\|success"
```

---

## Escalate if
- DLQ growing faster than dlq-reprocessor can consume
- Same message failing repeatedly after 3 manual retries
- Data loss for a tenant confirmed
