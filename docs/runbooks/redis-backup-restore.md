# Runbook: Redis Backup and Restore

**Purpose:** Capture and restore the standalone Redis instance used by the local Docker stack for cache and lock validation drills.  
**Service affected:** bff, saga-orchestrator, jobs-worker, workflow-alerts

---

## Scope

This runbook targets the standalone Redis container in local Docker:

- redis container: `grainguard-redis`
- scripts:
  - [`backup-redis.sh`](infra/scripts/backup-redis.sh)
  - [`restore-redis.sh`](infra/scripts/restore-redis.sh)

It does **not** back up the six-node Redis cluster used for cluster-mode experiments.

---

## Backup

```bash
./infra/scripts/backup-redis.sh
```

Optional custom target:

```bash
BACKUP_ROOT=/tmp/grainguard-backups ./infra/scripts/backup-redis.sh
```

Expected output:

- `infra/backups/redis/<timestamp>/dump.rdb`
- `infra/backups/redis/<timestamp>/metadata.env`

---

## Verify backup

```bash
ls -lh infra/backups/redis/<timestamp>
```

Sanity check Redis before restore work:

```bash
docker exec grainguard-redis redis-cli PING
docker exec grainguard-redis redis-cli DBSIZE
```

---

## Restore

Warning: this restarts the Redis container and can evict hot cache state and distributed locks.

```bash
./infra/scripts/restore-redis.sh infra/backups/redis/<timestamp>
```

---

## Verify recovery

```bash
docker exec grainguard-redis redis-cli PING
docker exec grainguard-redis redis-cli DBSIZE
docker logs --tail 100 grainguard-bff
docker logs --tail 100 grainguard-saga-orchestrator
```

Optional application check:

```bash
curl -fsS http://localhost:8086/health
```

If application logs still show stale lock/cache issues, restart the consumers:

```bash
docker compose -f infra/docker/docker-compose.yml restart bff saga-orchestrator jobs-worker workflow-alerts
```

---

## Escalate if

- Redis fails to start after replacing `dump.rdb`
- `PING` fails after restore
- cache recovers but saga lock keys remain permanently stale
- you need Redis Cluster restore, not standalone Redis restore
