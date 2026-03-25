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
```

---

## Fix — Redis pod crashed, restart

```bash
kubectl rollout restart deployment/redis -n grainguard-dev
kubectl rollout status deployment/redis -n grainguard-dev --timeout=60s

# Verify Redis is responding
kubectl exec -n grainguard-dev deploy/redis -- redis-cli PING
# Expected: PONG
```

---

## Fix — Redis OOM (evicting keys aggressively)

```bash
# Check current maxmemory policy
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli CONFIG GET maxmemory-policy

# Set to allkeys-lru if not already (safe for cache workloads)
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli CONFIG SET maxmemory-policy allkeys-lru

# Flush only telemetry cache keys if needed (leaves lock keys intact)
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli --scan --pattern "telemetry:*" | xargs redis-cli DEL
```

---

## Fix — Stale distributed lock blocking saga

```bash
# List all lock keys
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli --scan --pattern "lock:*"

# Check TTL on a specific lock (should auto-expire)
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli TTL "lock:saga:<saga-id>"

# If TTL is -1 (no expiry — bug), manually delete
kubectl exec -n grainguard-dev deploy/redis -- \
  redis-cli DEL "lock:saga:<saga-id>"
```

---

## Verify recovery

```bash
# BFF cache should start hitting again
kubectl logs -n grainguard-dev deploy/bff --since=2m | grep "cache hit"

# Saga should acquire locks successfully
kubectl logs -n grainguard-dev deploy/saga-orchestrator --since=2m \
  | grep "lock acquired"

# Check response time is back to normal in Grafana
# Dashboard: GrainGuard SLO → Gateway p95
```

---

## Escalate if
- Redis data persistence required (AOF/RDB corrupted)
- Memory cannot be reclaimed after eviction
- Lock keys with no TTL appearing repeatedly (code bug in lock release)
