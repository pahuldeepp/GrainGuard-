#!/usr/bin/env sh
# migrate.sh — Idempotent migration runner for GrainGuard.
#
# Applies all *.up.sql files in MIGRATIONS_DIR that have not yet been
# recorded in the schema_migrations table.
#
# Usage (called by the db-migrate docker-compose service):
#   PGHOST=postgres PGPASSWORD=postgres sh migrate.sh
#
# Can also be run manually:
#   PGHOST=localhost PGPASSWORD=postgres sh infra/scripts/migrate.sh

set -eu

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-grainguard}"
PGUSER="${PGUSER:-postgres}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

export PGPASSWORD="${PGPASSWORD:-postgres}"

psql() {
  command psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
}

echo "[migrate] Ensuring schema_migrations table exists..."
psql -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
"

echo "[migrate] Scanning $MIGRATIONS_DIR for pending *.up.sql files..."

found=0
applied=0

for migration_file in "$MIGRATIONS_DIR"/*.up.sql; do
  [ -f "$migration_file" ] || continue
  found=$((found + 1))

  # Derive version from filename: 000004_foo.up.sql → 000004_foo
  version=$(basename "$migration_file" .up.sql)

  already=$(psql -tAc "SELECT COUNT(*) FROM schema_migrations WHERE version = '$version'")

  if [ "$already" = "0" ]; then
    echo "[migrate] Applying: $version"
    psql -v ON_ERROR_STOP=1 -f "$migration_file"
    psql -c "INSERT INTO schema_migrations (version) VALUES ('$version') ON CONFLICT DO NOTHING;"
    echo "[migrate] OK: $version"
    applied=$((applied + 1))
  else
    echo "[migrate] Skip: $version (already applied)"
  fi
done

echo "[migrate] Done. $applied/$found migration(s) applied."
