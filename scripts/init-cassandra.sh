#!/usr/bin/env bash
# scripts/init-cassandra.sh
# Run as an init container: waits for Cassandra to be ready, then applies the schema.
set -euo pipefail

CASSANDRA_HOST="${CASSANDRA_HOST:-cassandra}"
CASSANDRA_PORT="${CASSANDRA_PORT:-9042}"
MAX_RETRIES="${MAX_RETRIES:-40}"
RETRY_DELAY="${RETRY_DELAY:-5}"

SCHEMA_FILE="${SCHEMA_FILE:-/schema/cassandra-schema.cql}"

log() { echo "[init-cassandra] $*"; }

# ── Wait for Cassandra to accept connections ──────────────────────────────────
log "Waiting for Cassandra at ${CASSANDRA_HOST}:${CASSANDRA_PORT}..."

for i in $(seq 1 "$MAX_RETRIES"); do
  if cqlsh "$CASSANDRA_HOST" "$CASSANDRA_PORT" -e "DESCRIBE KEYSPACES;" > /dev/null 2>&1; then
    log "Cassandra is ready (attempt $i)"
    break
  fi
  if [ "$i" -eq "$MAX_RETRIES" ]; then
    log "ERROR: Cassandra did not become ready after $MAX_RETRIES attempts — aborting"
    exit 1
  fi
  log "Attempt $i/$MAX_RETRIES — not ready yet, retrying in ${RETRY_DELAY}s..."
  sleep "$RETRY_DELAY"
done

# ── Apply schema ──────────────────────────────────────────────────────────────
if [ ! -f "$SCHEMA_FILE" ]; then
  log "ERROR: schema file not found at $SCHEMA_FILE"
  exit 1
fi

log "Applying schema from $SCHEMA_FILE..."
cqlsh "$CASSANDRA_HOST" "$CASSANDRA_PORT" -f "$SCHEMA_FILE"
log "Schema applied successfully."