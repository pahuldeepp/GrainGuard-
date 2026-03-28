#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <backup-dir>" >&2
  exit 1
fi

BACKUP_DIR="$1"
RDB_FILE="${BACKUP_DIR}/dump.rdb"
REDIS_CONTAINER="${REDIS_CONTAINER:-grainguard-redis}"

if [[ ! -f "${RDB_FILE}" ]]; then
  echo "[redis-restore] backup file not found: ${RDB_FILE}" >&2
  exit 1
fi

echo "[redis-restore] stopping ${REDIS_CONTAINER}"
docker stop "${REDIS_CONTAINER}" >/dev/null

# Copy the RDB snapshot then clear any existing AOF files so Redis loads
# the restored dump on startup rather than replaying an AOF that would
# conflict with or overwrite the snapshot data.
docker cp "${RDB_FILE}" "${REDIS_CONTAINER}:/data/dump.rdb"
docker run --rm --volumes-from "${REDIS_CONTAINER}" alpine \
  sh -c 'rm -f /data/appendonly.aof /data/appendonly.aof.manifest /data/*.aof.bak 2>/dev/null; echo "[redis-restore] AOF cleared"'

echo "[redis-restore] starting ${REDIS_CONTAINER}"
docker start "${REDIS_CONTAINER}" >/dev/null

# Wait until Redis is ready to accept connections (up to 30 s)
echo "[redis-restore] waiting for Redis to be ready..."
for i in $(seq 1 30); do
  if docker exec "${REDIS_CONTAINER}" redis-cli PING 2>/dev/null | grep -q PONG; then
    break
  fi
  sleep 1
done
docker exec "${REDIS_CONTAINER}" redis-cli PING | grep -q PONG \
  || { echo "[redis-restore] ERROR: Redis did not become ready after 30s" >&2; exit 1; }

echo "[redis-restore] restore completed"
