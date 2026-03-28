# Runbook: Postgres Backup and Restore

**Purpose:** Capture and restore both the write-model and read-model Postgres databases for local drills and operator validation.  
**Service affected:** telemetry-service, saga-orchestrator, bff, read-model-builder, asset-registry

---

## Scope

This runbook matches the local Docker stack:

- write DB container: `grainguard-postgres`
- read DB container: `grainguard-postgres-read`
- scripts:
  - [`backup-postgres.sh`](infra/scripts/backup-postgres.sh)
  - [`restore-postgres.sh`](infra/scripts/restore-postgres.sh)

These scripts create custom-format dumps for:

- `grainguard`
- `grainguard_read`

---

## Backup

```bash
./infra/scripts/backup-postgres.sh
```

Optional custom target:

```bash
BACKUP_ROOT=/tmp/grainguard-backups ./infra/scripts/backup-postgres.sh
```

Expected output:

- `infra/backups/postgres/<timestamp>/grainguard.dump`
- `infra/backups/postgres/<timestamp>/grainguard_read.dump`
- `infra/backups/postgres/<timestamp>/metadata.env`

---

## Verify backup

```bash
ls -lh infra/backups/postgres/<timestamp>
```

Optional quick integrity check:

```bash
docker exec -i grainguard-postgres pg_restore -l < infra/backups/postgres/<timestamp>/grainguard.dump | head
docker exec -i grainguard-postgres-read pg_restore -l < infra/backups/postgres/<timestamp>/grainguard_read.dump | head
```

---

## Restore

Warning: this is destructive. The target database is dropped and recreated before restore.

Restore both databases:

```bash
./infra/scripts/restore-postgres.sh infra/backups/postgres/<timestamp>
```

Restore only the write DB:

```bash
./infra/scripts/restore-postgres.sh infra/backups/postgres/<timestamp> write
```

Restore only the read DB:

```bash
./infra/scripts/restore-postgres.sh infra/backups/postgres/<timestamp> read
```

---

## Verify recovery

```bash
docker exec grainguard-postgres psql -U postgres -d grainguard -c '\dt'
docker exec grainguard-postgres-read psql -U postgres -d grainguard_read -c '\dt'
curl -fsS http://localhost:8086/health
curl -fsS http://localhost:4000/graphql -H 'content-type: application/json' -d '{"query":"{ __typename }"}'
```

Check application logs if a service still has stale connections:

```bash
docker logs --tail 100 grainguard-gateway
docker logs --tail 100 grainguard-bff
docker logs --tail 100 grainguard-telemetry
```

If needed, restart readers and API services:

```bash
docker compose -f infra/docker/docker-compose.yml restart gateway bff telemetry-service read-model-builder saga-orchestrator
```

---

## Escalate if

- `pg_restore` reports schema corruption
- backup files cannot be listed by `pg_restore -l`
- write DB restores successfully but read projections remain empty after service restart
- WAL/replication behavior is required rather than simple logical dump restore
