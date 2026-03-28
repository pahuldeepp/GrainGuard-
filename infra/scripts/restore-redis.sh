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
docker cp "${RDB_FILE}" "${REDIS_CONTAINER}:/data/dump.rdb"
echo "[redis-restore] starting ${REDIS_CONTAINER}"
docker start "${REDIS_CONTAINER}" >/dev/null
docker exec "${REDIS_CONTAINER}" redis-cli PING >/dev/null

echo "[redis-restore] restore completed"
