#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-${ROOT_DIR}/backups}"
TIMESTAMP="${TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_DIR="${BACKUP_ROOT}/redis/${TIMESTAMP}"

REDIS_CONTAINER="${REDIS_CONTAINER:-grainguard-redis}"

mkdir -p "${BACKUP_DIR}"

echo "[redis-backup] triggering SAVE on ${REDIS_CONTAINER}"
docker exec "${REDIS_CONTAINER}" redis-cli SAVE >/dev/null
docker cp "${REDIS_CONTAINER}:/data/dump.rdb" "${BACKUP_DIR}/dump.rdb"

cat > "${BACKUP_DIR}/metadata.env" <<EOF
TIMESTAMP=${TIMESTAMP}
REDIS_CONTAINER=${REDIS_CONTAINER}
EOF

echo "[redis-backup] created:"
ls -lh "${BACKUP_DIR}"
