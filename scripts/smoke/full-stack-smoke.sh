#!/usr/bin/env bash

set -euo pipefail

WRITE_DB_CONTAINER="${WRITE_DB_CONTAINER:-grainguard-postgres}"
READ_DB_CONTAINER="${READ_DB_CONTAINER:-grainguard-postgres-read}"
TELEMETRY_CONTAINER="${TELEMETRY_CONTAINER:-grainguard-telemetry}"
RISK_ENGINE_CONTAINER="${RISK_ENGINE_CONTAINER:-grainguard-risk-engine}"
WORKFLOW_ALERTS_CONTAINER="${WORKFLOW_ALERTS_CONTAINER:-grainguard-workflow-alerts}"
JOBS_WORKER_CONTAINER="${JOBS_WORKER_CONTAINER:-grainguard-jobs-worker}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-grainguard-gateway}"
READ_MODEL_BUILDER_CONTAINER="${READ_MODEL_BUILDER_CONTAINER:-grainguard-read-model-builder}"
SAGA_CONTAINER="${SAGA_CONTAINER:-grainguard-saga-orchestrator}"
ASSET_REGISTRY_CONTAINER="${ASSET_REGISTRY_CONTAINER:-grainguard-asset-registry}"

readonly RABBITMQ_URL="amqp://grainguard:grainguard@rabbitmq:5672/grainguard"
readonly STRIPE_QUEUE="grainguard.stripe.billing"
readonly TELEMETRY_TOPIC_DESC="device -> telemetry -> risk -> alert -> read-model"
readonly STRIPE_TOPIC_DESC="stripe worker payment-failed lifecycle"

smoke_tenant_id=""
smoke_device_id=""
stripe_tenant_id=""
stripe_customer_id=""
stripe_subscription_id=""

log() {
  printf '[smoke] %s\n' "$*"
}

psql_write() {
  docker exec -i "$WRITE_DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d grainguard "$@"
}

psql_read() {
  docker exec -i "$READ_DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d grainguard_read "$@"
}

query_write() {
  psql_write -Atqc "$1"
}

query_read() {
  psql_read -Atqc "$1"
}

container_running() {
  docker ps --format '{{.Names}}' | grep -Fxq "$1"
}

wait_for_condition() {
  local description="$1"
  local timeout_seconds="$2"
  local command="$3"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if eval "$command" >/dev/null 2>&1; then
      log "verified: ${description}"
      return 0
    fi
    sleep 1
  done

  log "FAILED waiting for: ${description}"
  return 1
}

wait_for_sql_value() {
  local description="$1"
  local timeout_seconds="$2"
  local database="$3"
  local sql="$4"
  local expected="$5"
  local deadline=$((SECONDS + timeout_seconds))
  local actual=""

  while (( SECONDS < deadline )); do
    if [[ "$database" == "write" ]]; then
      actual="$(query_write "$sql")"
    else
      actual="$(query_read "$sql")"
    fi

    if [[ "$actual" == "$expected" ]]; then
      log "verified: ${description}"
      return 0
    fi

    sleep 1
  done

  log "FAILED waiting for: ${description} (expected '$expected', got '${actual:-<empty>}')"
  return 1
}

wait_for_log_patterns() {
  local description="$1"
  local timeout_seconds="$2"
  local container="$3"
  shift 3
  local deadline=$((SECONDS + timeout_seconds))
  local logs=""
  local missing=0

  while (( SECONDS < deadline )); do
    logs="$(docker logs "$container" 2>&1 || true)"
    missing=0

    for pattern in "$@"; do
      if ! grep -Fq "$pattern" <<<"$logs"; then
        missing=1
        break
      fi
    done

    if (( missing == 0 )); then
      log "verified: ${description}"
      return 0
    fi

    sleep 1
  done

  log "FAILED waiting for: ${description}"
  return 1
}

cleanup() {
  set +e

  if [[ -n "$smoke_device_id" ]]; then
    psql_read -c "DELETE FROM device_telemetry_history WHERE device_id = '$smoke_device_id';" >/dev/null 2>&1
    psql_read -c "DELETE FROM device_telemetry_latest WHERE device_id = '$smoke_device_id';" >/dev/null 2>&1
    psql_read -c "DELETE FROM device_projections WHERE device_id = '$smoke_device_id';" >/dev/null 2>&1
    psql_write -c "DELETE FROM devices WHERE id = '$smoke_device_id';" >/dev/null 2>&1
  fi

  if [[ -n "$smoke_tenant_id" ]]; then
    psql_write -c "DELETE FROM tenant_users WHERE tenant_id = '$smoke_tenant_id';" >/dev/null 2>&1
    psql_write -c "DELETE FROM tenant_billing WHERE tenant_id = '$smoke_tenant_id';" >/dev/null 2>&1
    psql_write -c "DELETE FROM tenants WHERE id = '$smoke_tenant_id';" >/dev/null 2>&1
  fi

  if [[ -n "$stripe_tenant_id" ]]; then
    psql_write -c "DELETE FROM stripe_webhook_events WHERE stripe_event_id LIKE 'evt_smoke_%';" >/dev/null 2>&1
    psql_write -c "DELETE FROM devices WHERE tenant_id = '$stripe_tenant_id';" >/dev/null 2>&1
    psql_write -c "DELETE FROM tenant_users WHERE tenant_id = '$stripe_tenant_id';" >/dev/null 2>&1
    psql_write -c "DELETE FROM tenant_billing WHERE tenant_id = '$stripe_tenant_id';" >/dev/null 2>&1
    psql_write -c "DELETE FROM tenants WHERE id = '$stripe_tenant_id';" >/dev/null 2>&1
  fi
}

trap cleanup EXIT

for container in \
  "$WRITE_DB_CONTAINER" \
  "$READ_DB_CONTAINER" \
  "$TELEMETRY_CONTAINER" \
  "$RISK_ENGINE_CONTAINER" \
  "$WORKFLOW_ALERTS_CONTAINER" \
  "$JOBS_WORKER_CONTAINER" \
  "$GATEWAY_CONTAINER" \
  "$READ_MODEL_BUILDER_CONTAINER" \
  "$SAGA_CONTAINER" \
  "$ASSET_REGISTRY_CONTAINER"
do
  if ! container_running "$container"; then
    log "required container is not running: $container"
    exit 1
  fi
done

timestamp="$(date +%s)"
smoke_tenant_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
smoke_slug="smoke-$timestamp"
smoke_serial="SMOKE-$timestamp"

log "setting up smoke tenant for ${TELEMETRY_TOPIC_DESC}"
psql_write <<SQL >/dev/null
INSERT INTO tenants (id, name, slug, plan, subscription_status, created_at, updated_at)
VALUES ('$smoke_tenant_id', 'Smoke Tenant', '$smoke_slug', 'starter', 'active', NOW(), NOW());

INSERT INTO tenant_users (id, tenant_id, auth_user_id, email, role, created_at)
VALUES (gen_random_uuid(), '$smoke_tenant_id', 'auth0|smoke-$timestamp', 'smoke+$timestamp@example.com', 'admin', NOW());
SQL

log "creating smoke device through telemetry-service dev HTTP API"
create_response="$(
  docker exec "$TELEMETRY_CONTAINER" /bin/sh -lc \
    "wget -qO- --header='Content-Type: application/json' \
    --post-data='{\"tenant_id\":\"$smoke_tenant_id\",\"serial\":\"$smoke_serial\"}' \
    http://localhost:8080/devices"
)"

smoke_device_id="$(node -e 'const payload = JSON.parse(process.argv[1]); process.stdout.write(payload.ID);' "$create_response")"
log "device created: $smoke_device_id"

wait_for_sql_value \
  "device exists in write DB" \
  20 \
  "write" \
  "SELECT COUNT(*) FROM devices WHERE id = '$smoke_device_id';" \
  "1"

wait_for_sql_value \
  "device projection exists in read DB" \
  20 \
  "read" \
  "SELECT COUNT(*) FROM device_projections WHERE device_id = '$smoke_device_id';" \
  "1"

log "recording telemetry for smoke device"
telemetry_response="$(
  docker exec "$TELEMETRY_CONTAINER" /bin/sh -lc \
    "wget -qO- --server-response --header='Content-Type: application/json' \
    --post-data='{\"device_id\":\"$smoke_device_id\",\"temperature\":37.1,\"humidity\":81.5}' \
    http://localhost:8080/telemetry 2>&1"
)"

printf '%s\n' "$telemetry_response" | grep -Fq 'HTTP/1.1 201 Created'

wait_for_log_patterns \
  "risk-engine scored telemetry" \
  20 \
  "$RISK_ENGINE_CONTAINER" \
  "$smoke_device_id" \
  "Scored device="

wait_for_log_patterns \
  "workflow-alerts queued alert" \
  20 \
  "$WORKFLOW_ALERTS_CONTAINER" \
  "$smoke_device_id" \
  "alert queued"

wait_for_sql_value \
  "read-model latest telemetry updated" \
  20 \
  "read" \
  "SELECT COUNT(*) FROM device_telemetry_latest WHERE device_id = '$smoke_device_id' AND temperature = 37.1 AND humidity = 81.5;" \
  "1"

wait_for_sql_value \
  "read-model telemetry history updated" \
  20 \
  "read" \
  "SELECT COUNT(*) FROM device_telemetry_history WHERE device_id = '$smoke_device_id';" \
  "1"

log "setting up stripe smoke tenant for ${STRIPE_TOPIC_DESC}"
stripe_tenant_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
stripe_customer_id="cus_smoke_$timestamp"
stripe_subscription_id="sub_smoke_$timestamp"
stripe_slug="stripe-smoke-$timestamp"
stripe_event_id="evt_smoke_$timestamp"

psql_write <<SQL >/dev/null
INSERT INTO tenants (
  id, name, slug, plan, subscription_status, current_period_end, created_at, updated_at
)
VALUES (
  '$stripe_tenant_id',
  'Stripe Smoke Tenant',
  '$stripe_slug',
  'starter',
  'active',
  NOW() - INTERVAL '1 day',
  NOW(),
  NOW()
);

INSERT INTO tenant_users (id, tenant_id, auth_user_id, email, role, created_at)
VALUES (
  gen_random_uuid(),
  '$stripe_tenant_id',
  'auth0|stripe-smoke-$timestamp',
  'stripe-smoke+$timestamp@example.com',
  'admin',
  NOW()
);

INSERT INTO tenant_billing (
  tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, created_at, updated_at
)
VALUES (
  '$stripe_tenant_id',
  '$stripe_customer_id',
  '$stripe_subscription_id',
  'starter',
  'active',
  NOW(),
  NOW()
);

INSERT INTO devices (id, tenant_id, serial_number, disabled, created_at)
SELECT
  gen_random_uuid(),
  '$stripe_tenant_id',
  'STRIPE-SMOKE-' || gs::text,
  FALSE,
  NOW() - make_interval(secs => gs)
FROM generate_series(1, 7) AS gs;
SQL

log "publishing synthetic Stripe invoice.payment_failed event"
docker exec \
  -e RABBITMQ_URL="$RABBITMQ_URL" \
  -e STRIPE_QUEUE="$STRIPE_QUEUE" \
  -e STRIPE_EVENT_ID="$stripe_event_id" \
  -e STRIPE_CUSTOMER_ID="$stripe_customer_id" \
  -e STRIPE_SUBSCRIPTION_ID="$stripe_subscription_id" \
  -i "$JOBS_WORKER_CONTAINER" node <<'NODE' >/dev/null
const amqp = require("amqplib");

(async () => {
  const conn = await amqp.connect(process.env.RABBITMQ_URL);
  const ch = await conn.createChannel();
  await ch.checkQueue(process.env.STRIPE_QUEUE);
  const payload = {
    stripeEventId: process.env.STRIPE_EVENT_ID,
    stripeEventType: "invoice.payment_failed",
    payload: {
      id: "in_smoke_local",
      subscription: process.env.STRIPE_SUBSCRIPTION_ID,
      customer: process.env.STRIPE_CUSTOMER_ID,
      hosted_invoice_url: "https://example.test/invoice/smoke",
    },
  };
  ch.sendToQueue(
    process.env.STRIPE_QUEUE,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true },
  );
  await ch.close();
  await conn.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

wait_for_sql_value \
  "tenant_billing marked past_due" \
  20 \
  "write" \
  "SELECT status FROM tenant_billing WHERE tenant_id = '$stripe_tenant_id';" \
  "past_due"

wait_for_sql_value \
  "tenants.subscription_status marked past_due" \
  20 \
  "write" \
  "SELECT subscription_status FROM tenants WHERE id = '$stripe_tenant_id';" \
  "past_due"

wait_for_sql_value \
  "stripe webhook idempotency row created" \
  20 \
  "write" \
  "SELECT COUNT(*) FROM stripe_webhook_events WHERE stripe_event_id = '$stripe_event_id';" \
  "1"

wait_for_sql_value \
  "over-limit devices disabled after payment failure" \
  20 \
  "write" \
  "SELECT COUNT(*) FROM devices WHERE tenant_id = '$stripe_tenant_id' AND disabled = TRUE;" \
  "2"

log "all smoke checks passed"
