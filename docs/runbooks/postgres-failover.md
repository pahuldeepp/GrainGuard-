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
  psql -p 6432 -U pgbouncer pgbouncer -c "SHOW POOLS;"

# 5. Check recent errors in BFF
kubectl logs -n grainguard-dev deploy/bff --since=10m | grep -i "error\|circuit"
```

---

## Fix — Primary is down, promote replica

```bash
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
```

---

## Fix — Connection pool exhausted

```bash
# Reload PgBouncer config (no restart needed)
kubectl exec -n grainguard-dev deploy/pgbouncer -- \
  psql -p 6432 -U pgbouncer pgbouncer -c "RELOAD;"

# If still exhausted, kill idle connections
kubectl exec -n grainguard-dev deploy/postgres -- \
  psql -U grainguard -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE state = 'idle'
      AND state_change < now() - interval '5 minutes';"
```

---

## Verify recovery

```bash
# GraphQL health check
curl -s http://localhost:3000/healthz | jq .

# BFF circuit breaker should be closed
kubectl logs -n grainguard-dev deploy/bff --since=2m | grep "circuit"

# Confirm primary is writable
kubectl exec -n grainguard-dev deploy/postgres -- \
  psql -U grainguard -c "INSERT INTO healthcheck(ts) VALUES(now());"
```

---

## Escalate if
- Replica promotion fails
- Data loss suspected (check WAL position before/after)
- Both primary and replica are down
