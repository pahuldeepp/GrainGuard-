#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-${ROOT_DIR}/backups}"
TIMESTAMP="${TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_DIR="${BACKUP_ROOT}/postgres/${TIMESTAMP}"

WRITE_CONTAINER="${WRITE_CONTAINER:-grainguard-postgres}"
READ_CONTAINER="${READ_CONTAINER:-grainguard-postgres-read}"
PGUSER="${PGUSER:-postgres}"
WRITE_DB="${WRITE_DB:-grainguard}"
READ_DB="${READ_DB:-grainguard_read}"

mkdir -p "${BACKUP_DIR}"

echo "[postgres-backup] writing backups into ${BACKUP_DIR}"

docker exec "${WRITE_CONTAINER}" pg_dump \
  -U "${PGUSER}" \
  -d "${WRITE_DB}" \
  -Fc > "${BACKUP_DIR}/${WRITE_DB}.dump"

docker exec "${READ_CONTAINER}" pg_dump \
  -U "${PGUSER}" \
  -d "${READ_DB}" \
  -Fc > "${BACKUP_DIR}/${READ_DB}.dump"

cat > "${BACKUP_DIR}/metadata.env" <<EOF
TIMESTAMP=${TIMESTAMP}
WRITE_CONTAINER=${WRITE_CONTAINER}
READ_CONTAINER=${READ_CONTAINER}
PGUSER=${PGUSER}
WRITE_DB=${WRITE_DB}
READ_DB=${READ_DB}
EOF

echo "[postgres-backup] created:"
ls -lh "${BACKUP_DIR}"
