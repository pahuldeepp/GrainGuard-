# Runbook: Postgres Failover

**Alert:** `PostgresPrimaryDown` / `PostgresReplicaLagHigh`  
**Severity:** Critical  
**Service affected:** telemetry-service, bff, saga-orchestrator, read-model-builder

---

## Symptoms
- GraphQL queries returning 500
- BFF circuit breaker open (check logs for `circuit breaker open`)
- `pg_is_in_recovery()` returning unexpected value
- Replica lag metric `pg_replication_lag_seconds > 30`

---

## Diagnosis

```bash
# 1. Check which pod is primary
kubectl exec -n grainguard-dev deploy/postgres -- \
  psql -U grainguard -c "SELECT pg_is_in_recovery();"
# false = primary, true = replica

# 2. Check replication lag
kubectl exec -n grainguard-dev deploy/postgres -- \
  psql -U grainguard -c "SELECT * FROM pg_stat_replication;"

# 3. Check connection count
kubectl exec -n grainguard-dev deploy/postgres -- \
  psql -U grainguard -c "SELECT count(*) FROM pg_stat_activity;"

# 4. Check PgBouncer pool status
kubectl exec -n grainguard-dev deploy/pgbouncer -- \
  psql -p 5432 -U pgbouncer pgbouncer -c "SHOW POOLS;"

# 5. Check recent errors in BFF
kubectl logs -n grainguard-dev deploy/bff --since=10m | grep -i "error\|circuit"

Fix — Primary is down, promote replica
# 1. Identify the replica pod
kubectl get pods -n grainguard-dev -l app=postgres-read

# 2. Promote replica to primary
kubectl exec -n grainguard-dev deploy/postgres-read -- \
  pg_ctl promote -D /var/lib/postgresql/data

# 3. Update the DATABASE_URL secret to point to replica
kubectl patch secret grainguard-secrets -n grainguard-dev \
  --patch '{"stringData":{"DATABASE_URL":"postgres://grainguard:grainguard@postgres-read:5432/grainguard"}}'

# 4. Restart affected services to pick up new connection
kubectl rollout restart deployment/bff deployment/telemetry-service \
  deployment/saga-orchestrator -n grainguard-dev

# 5. Verify services are healthy
kubectl rollout status deployment/bff -n grainguard-dev --timeout=60s

Fix — Connection pool exhausted
# Reload PgBouncer config (no restart needed)
kubectl exec -n grainguard-dev deploy/pgbouncer -- \
  psql -p 5432 -U pgbouncer pgbouncer -c "RELOAD;"

# If still exhausted, kill idle connections
kubectl exec -n grainguard-dev deploy/postgres -- \
  psql -U grainguard -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE state = 'idle'
      AND state_change < now() - interval '5 minutes';"

Verify recovery
# GraphQL health check
curl -s http://localhost:3000/healthz | jq .

# BFF circuit breaker should be closed
kubectl logs -n grainguard-dev deploy/bff --since=2m | grep "circuit"

# Confirm primary is writable
kubectl exec -n grainguard-dev deploy/postgres -- \
  psql -U grainguard -c "INSERT INTO healthcheck(ts) VALUES(now());"

Escalate if
Replica promotion fails
Data loss suspected (check WAL position before/after)
Both primary and replica are down

---

### `docs/runbooks/kafka-loss.md`

```markdown
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

Fix — Broker pod crashed, restart it
# Restart the broker
kubectl rollout restart deployment/kafka -n grainguard-dev
kubectl rollout status deployment/kafka -n grainguard-dev --timeout=120s

# Wait for partition reassignment to complete
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-topics.sh --bootstrap-server kafka:9092 \
  --describe --under-replicated-partitions
# Output should be empty when fully replicated

Fix — Consumer group stuck / rebalancing forever
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

Fix — DLQ has messages (schema/deserialization error)
# Consume from DLQ to inspect bad messages
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 \
  --topic telemetry.events.dlq \
  --from-beginning --max-messages 10

# Trigger dlq-reprocessor to retry
kubectl rollout restart deployment/dlq-reprocessor -n grainguard-dev

Verify recovery
# Consumer lag should be dropping
watch -n5 'kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group read-model-builder | grep -v "^$"'

# Ingest endpoint should return 202
curl -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test","temperature":22.5,"humidity":60}'

Escalate if
Data loss confirmed (offset gaps in partition)
Broker disk full (df -h inside broker pod)
All brokers down simultaneously

---

### `docs/runbooks/dlq-spike.md`

```markdown
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

Fix — Schema validation error (malformed payload)
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

Fix — Downstream dependency down (Postgres/Redis)
# If DLQ messages are failing because Postgres is down,
# pause dlq-reprocessor until DB is healthy
kubectl scale deployment/dlq-reprocessor -n grainguard-dev --replicas=0

# Fix the upstream issue (see postgres-failover.md or redis-failover.md)

# Then resume
kubectl scale deployment/dlq-reprocessor -n grainguard-dev --replicas=1

Fix — Retry all DLQ messages after root cause fixed
# Reset DLQ consumer to beginning to replay all messages
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --group dlq-reprocessor \
  --topic telemetry.events.dlq \
  --reset-offsets --to-earliest --execute

kubectl rollout restart deployment/dlq-reprocessor -n grainguard-dev

Verify recovery
# DLQ offset should stop growing
kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-run-class.sh kafka.tools.GetOffsetShell \
  --broker-list kafka:9092 --topic telemetry.events.dlq

# dlq-reprocessor logs should show successful processing
kubectl logs -n grainguard-dev deploy/dlq-reprocessor --since=5m \
  | grep -i "processed\|success"

Escalate if
DLQ growing faster than dlq-reprocessor can consume
Same message failing repeatedly after 3 manual retries
Data loss for a tenant confirmed

---

### `docs/runbooks/redis-failover.md`

```markdown
# Runbook: Redis Failover

**Alert:** `RedisDown` / `RedisCacheMissRateHigh`  
**Severity:** Critical  
**Service affected:** bff (cache + distributed lock), saga-orchestrator (lock)

---

## Symptoms
- BFF response times spike (falling back to Postgres on every request)
- Saga-orchestrator lock acquisition failing (logs: `failed to acquire lock`)
- Cache miss rate 100% in Grafana
- Redis pod in CrashLoopBackOff

---

## Diagnosis

```bash
# 1. Check Redis pod
kubectl get pods -n grainguard-dev -l app=redis
kubectl describe pod -n grainguard-dev -l app=redis

# 2. Check Redis memory usage
kubectl exec -n grainguard-dev deploy/redis -- redis-cli INFO memory \
  | grep -E "used_memory_human|maxmemory_human"

# 3. Check eviction rate
kubectl exec -n grainguard-dev deploy/redis -- redis-cli INFO stats \
  | grep evicted_keys

# 4. Check BFF is falling back gracefully
kubectl logs -n grainguard-dev deploy/bff --since=10m \
  | grep -i "redis\|cache\|fallback"

# 5. Check saga lock errors
kubectl logs -n grainguard-dev deploy/saga-orchestrator --since=10m \
  | grep -i "lock\|redis"

Fix — Redis pod crashed, restart
kubectl rollout restart deployment/redis -n grainguard-dev
kubectl rollout status deployment/redis -n grainguard-dev --timeout=60s

# Verify Redis is responding
kubectl exec -n grainguard-dev deploy/redis -- redis-cli PING
# Expected: PONG

Fix — Redis OOM (evicting keys aggressively)
# Check current maxmemory policy
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli CONFIG GET maxmemory-policy

# Set to allkeys-lru if not already (safe for cache workloads)
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli CONFIG SET maxmemory-policy allkeys-lru

# Flush only telemetry cache keys if needed (leaves lock keys intact)
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli --scan --pattern "telemetry:*" | xargs redis-cli DEL

Fix — Stale distributed lock blocking saga
# List all lock keys
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli --scan --pattern "lock:*"

# Check TTL on a specific lock (should auto-expire)
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli TTL "lock:saga:<saga-id>"

# If TTL is -1 (no expiry — bug), manually delete
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli DEL "lock:saga:<saga-id>"

Verify recovery
# BFF cache should start hitting again
kubectl logs -n grainguard-dev deploy/bff --since=2m | grep "cache hit"

# Saga should acquire locks successfully
kubectl logs -n grainguard-dev deploy/saga-orchestrator --since=2m \
  | grep "lock acquired"

# Check response time is back to normal in Grafana
# Dashboard: GrainGuard SLO → Gateway p95

Escalate if
Redis data persistence required (AOF/RDB corrupted)
Memory cannot be reclaimed after eviction
Lock keys with no TTL appearing repeatedly (code bug in lock release)

---

### `docs/runbooks/projection-lag.md`

```markdown
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

Fix — Consumer is healthy but slow (scale out)
# Scale read-model-builder (max = partition count on telemetry.events)
kubectl scale deployment/read-model-builder \
  -n grainguard-dev --replicas=3

# Monitor lag dropping
watch -n5 'kubectl exec -n grainguard-dev deploy/kafka -- \
  kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group read-model-builder'

Fix — Consumer pod OOMKilled
# Increase memory limit temporarily
kubectl set resources deployment/read-model-builder \
  -n grainguard-dev \
  --limits=memory=1Gi --requests=memory=512Mi

kubectl rollout status deployment/read-model-builder \
  -n grainguard-dev --timeout=60s

Fix — Consumer crashed on bad message (poison pill)
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

Verify recovery
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

Escalate if
Lag not dropping after scaling to max partitions
Postgres write latency > 1s (DB is the bottleneck, not consumer)
Bad messages keep appearing after offset skip (upstream schema bug)

---

### `docs/runbooks/grpc-outage.md`

```markdown
# Runbook: gRPC Inter-Service Outage

**Alert:** `GrpcErrorRateHigh` / circuit breaker open in service logs  
**Severity:** Critical  
**Service affected:** Any service using gRPC (telemetry-service, asset-registry, saga-orchestrator)

---

## Symptoms
- HTTP 503 from gateway with `upstream connect error`
- Service logs: `rpc error: code = Unavailable`
- Circuit breaker logs: `circuit breaker open for <service>`
- mTLS certificate errors in logs

---

## Diagnosis

```bash
# 1. Which gRPC service is failing?
kubectl logs -n grainguard-dev deploy/gateway --since=10m \
  | grep -i "grpc\|rpc error\|unavailable"

# 2. Check the target service pod is running
kubectl get pods -n grainguard-dev -l app=telemetry-service
kubectl get pods -n grainguard-dev -l app=asset-registry

# 3. Test gRPC connectivity directly (requires grpcurl)
kubectl run grpc-test --rm -it --image=fullstorydev/grpcurl \
  --restart=Never -n grainguard-dev -- \
  -plaintext telemetry-service:50051 list

# 4. Check mTLS certificate expiry
kubectl get secret grainguard-tls -n grainguard-dev -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -noout -dates

# 5. Check service endpoints are registered
kubectl get endpoints -n grainguard-dev telemetry-service
kubectl get endpoints -n grainguard-dev asset-registry

Fix — Target service pod is down
kubectl rollout restart deployment/telemetry-service -n grainguard-dev
kubectl rollout status deployment/telemetry-service -n grainguard-dev --timeout=60s

# Circuit breaker will close automatically once service is healthy
# Watch for: "circuit breaker closed" in caller logs
kubectl logs -n grainguard-dev deploy/gateway --since=2m | grep "circuit"

Fix — mTLS certificate expired
# Renew the TLS secret (cert-manager will auto-renew if configured)
kubectl annotate certificate grainguard-tls -n grainguard-dev \
  cert-manager.io/issue-temporary-certificate="true"

# Or manually rotate:
kubectl delete secret grainguard-tls -n grainguard-dev
# cert-manager will recreate it automatically

# Restart services to pick up new certs
kubectl rollout restart deployment/telemetry-service \
  deployment/saga-orchestrator deployment/asset-registry \
  -n grainguard-dev

Fix — Service endpoint not registered (pod not ready)
# Check why pod is not passing readiness probe
kubectl describe pod -n grainguard-dev -l app=telemetry-service \
  | grep -A10 "Readiness"

# Check liveness probe failures
kubectl describe pod -n grainguard-dev -l app=telemetry-service \
  | grep -A5 "Liveness"

# Common fix: service needs env var / secret that's missing
kubectl get pod -n grainguard-dev -l app=telemetry-service \
  -o jsonpath='{.items[0].spec.containers[0].env}' | jq .

Verify recovery
# No gRPC errors in gateway
kubectl logs -n grainguard-dev deploy/gateway --since=2m \
  | grep -c "rpc error"
# Expected: 0

# Circuit breaker closed
kubectl logs -n grainguard-dev deploy/gateway --since=2m \
  | grep "circuit breaker"

# End-to-end test
curl -s -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_JWT" \
  -d '{"query":"{ devices(limit:1) { deviceId } }"}' | jq .

Escalate if
All replicas of a service failing readiness simultaneously
Certificate renewal failing (cert-manager issue)
Network policy blocking inter-service traffic