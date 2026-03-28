#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <backup-dir> [write|read|both]" >&2
  exit 1
fi

BACKUP_DIR="$1"
RESTORE_SCOPE="${2:-both}"

if [[ ! -d "${BACKUP_DIR}" ]]; then
  echo "[postgres-restore] backup dir not found: ${BACKUP_DIR}" >&2
  exit 1
fi

WRITE_CONTAINER="${WRITE_CONTAINER:-grainguard-postgres}"
READ_CONTAINER="${READ_CONTAINER:-grainguard-postgres-read}"
PGUSER="${PGUSER:-postgres}"
WRITE_DB="${WRITE_DB:-grainguard}"
READ_DB="${READ_DB:-grainguard_read}"

restore_db() {
  local container="$1"
  local db="$2"
  local dump_file="$3"

  if [[ ! -f "${dump_file}" ]]; then
    echo "[postgres-restore] dump file missing: ${dump_file}" >&2
    exit 1
  fi

  echo "[postgres-restore] restoring ${db} into ${container}"
  docker exec "${container}" psql -U "${PGUSER}" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${db};"
  docker exec "${container}" psql -U "${PGUSER}" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE ${db};"
  docker exec -i "${container}" pg_restore \
    -U "${PGUSER}" \
    -d "${db}" \
    --no-owner \
    --clean \
    --if-exists < "${dump_file}"
}

case "${RESTORE_SCOPE}" in
  write)
    restore_db "${WRITE_CONTAINER}" "${WRITE_DB}" "${BACKUP_DIR}/${WRITE_DB}.dump"
    ;;
  read)
    restore_db "${READ_CONTAINER}" "${READ_DB}" "${BACKUP_DIR}/${READ_DB}.dump"
    ;;
  both)
    restore_db "${WRITE_CONTAINER}" "${WRITE_DB}" "${BACKUP_DIR}/${WRITE_DB}.dump"
    restore_db "${READ_CONTAINER}" "${READ_DB}" "${BACKUP_DIR}/${READ_DB}.dump"
    ;;
  *)
    echo "[postgres-restore] invalid scope: ${RESTORE_SCOPE}" >&2
    echo "expected one of: write, read, both" >&2
    exit 1
    ;;
esac

echo "[postgres-restore] restore completed"
