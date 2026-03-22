# Runbook: Kafka Message Loss / Broker Down

**Alert:** `KafkaBrokerDown` / `KafkaUnderReplicatedPartitions`
**Severity:** Critical
**Service affected:** telemetry-service (producer), read-model-builder, cdc-transformer, dlq-reprocessor (consumers)

---

## Symptoms
- Telemetry ingest returning 500 or hanging
- Consumer lag spiking across all groups
- `kafka_brokers` metric dropping below expected count
- Under-replicated partitions > 0

---

## Diagnosis

```bash
# 1. Check broker pods
kubectl get pods -n grainguard-dev -l app=kafka

# 2. List under-replicated partitions
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-topics.sh --bootstrap-server kafka:9092 \
  --describe --under-replicated-partitions

# 3. Check consumer group status
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group read-model-builder

# 4. Check producer errors in telemetry-service
kubectl logs -n grainguard-dev deploy/telemetry-service --since=10m \
  | grep -i "kafka\|produce\|error"

# 5. Check topic offsets
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-run-class.sh kafka.tools.GetOffsetShell \
  --broker-list kafka:9092 --topic telemetry.events
```

---

## Fix — Broker pod crashed, restart it

```bash
# Restart the broker
kubectl rollout restart deployment/kafka -n grainguard-dev
kubectl rollout status deployment/kafka -n grainguard-dev --timeout=120s

# Wait for partition reassignment to complete
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-topics.sh --bootstrap-server kafka:9092 \
  --describe --under-replicated-partitions
# Output should be empty when fully replicated
```

---

## Fix — Consumer group stuck / rebalancing forever

```bash
# 1. Check if any consumer has a lock on a partition
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group read-model-builder

# 2. If EMPTY state for too long, reset offset to latest to skip bad messages
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --group read-model-builder \
  --topic telemetry.events \
  --reset-offsets --to-latest --execute

# 3. Restart consumers
kubectl rollout restart deployment/read-model-builder \
  deployment/cdc-transformer -n grainguard-dev
```

---

## Fix — DLQ has messages (schema/deserialization error)

```bash
# Consume from DLQ to inspect bad messages
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 \
  --topic telemetry.events.dlq \
  --from-beginning --max-messages 10

# Trigger dlq-reprocessor to retry
kubectl rollout restart deployment/dlq-reprocessor -n grainguard-dev
```

---

## Verify recovery

```bash
# Consumer lag should be dropping
watch -n5 'kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group read-model-builder | grep -v "^$"'

# Ingest endpoint should return 202
curl -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test","temperature":22.5,"humidity":60}'
```

---

## Escalate if
- Data loss confirmed (offset gaps in partition)
- Broker disk full (`df -h` inside broker pod)
- All brokers down simultaneously
