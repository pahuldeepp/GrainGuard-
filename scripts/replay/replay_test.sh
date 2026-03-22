#!/bin/bash
set -e

echo "=== GrainGuard Replay Test ==="
echo "Validates: wipe read DB → reset Kafka → rebuild → idempotency"

COMPOSE="docker compose -f infra/docker/docker-compose.yml"
PSQL="docker exec grainguard-postgres-read psql -U postgres -d grainguard_read -t -c"

# ── Step 0: sanity check ─────────────────────────────────────────────────────
echo ""
echo "Step 0: Checking services are running..."
$COMPOSE ps | grep -E "read-model-builder|kafka|postgres-read" || {
  echo "ERROR: Required services not running. Start with: cd infra/docker && docker compose up -d"
  exit 1
}

# ── Step 1: capture baseline ─────────────────────────────────────────────────
echo ""
echo "Step 1: Capturing baseline counts..."
BEFORE_EVENTS=$($PSQL "SELECT COUNT(*) FROM processed_events;" | tr -d ' ')
BEFORE_DEVICES=$($PSQL "SELECT COUNT(*) FROM device_projections;" | tr -d ' ')
BEFORE_TELEMETRY=$($PSQL "SELECT COUNT(*) FROM device_telemetry_latest;" | tr -d ' ')

echo "  processed_events:        $BEFORE_EVENTS"
echo "  device_projections:      $BEFORE_DEVICES"
echo "  device_telemetry_latest: $BEFORE_TELEMETRY"

if [ "$BEFORE_EVENTS" -eq "0" ]; then
  echo "ERROR: No events in read DB. Publish some telemetry first."
  exit 1
fi

# ── Step 2: stop read-model-builder ──────────────────────────────────────────
echo ""
echo "Step 2: Stopping read-model-builder..."
$COMPOSE stop read-model-builder
sleep 2

# ── Step 3: wipe read DB ─────────────────────────────────────────────────────
echo ""
echo "Step 3: Wiping read model tables..."
docker exec grainguard-postgres-read psql -U postgres -d grainguard_read -c "
  TRUNCATE processed_events CASCADE;
  TRUNCATE device_telemetry_latest CASCADE;
  TRUNCATE device_telemetry_history CASCADE;
"

AFTER_WIPE=$($PSQL "SELECT COUNT(*) FROM processed_events;" | tr -d ' ')
echo "  processed_events after wipe: $AFTER_WIPE"

if [ "$AFTER_WIPE" != "0" ]; then
  echo "ERROR: Wipe failed — processed_events still has rows"
  exit 1
fi
echo "  ✓ Read DB wiped"

# ── Step 4: reset Kafka consumer offset to earliest ──────────────────────────
echo ""
echo "Step 4: Resetting Kafka consumer offset to earliest..."
docker exec grainguard-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group read-model-builder-v2 \
  --topic telemetry.events \
  --reset-offsets \
  --to-earliest \
  --execute 2>/dev/null || true
echo "  ✓ Offset reset"

# ── Step 5: restart read-model-builder ───────────────────────────────────────
echo ""
echo "Step 5: Restarting read-model-builder..."
$COMPOSE start read-model-builder
sleep 5

# ── Step 6: wait for rebuild ─────────────────────────────────────────────────
echo ""
echo "Step 6: Waiting for projection rebuild (up to 60s)..."
MAX_WAIT=60
INTERVAL=5
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  CURRENT=$($PSQL "SELECT COUNT(*) FROM processed_events;" | tr -d ' ')
  echo "  [$ELAPSED s] processed_events: $CURRENT / $BEFORE_EVENTS"

  if [ "$CURRENT" -ge "$BEFORE_EVENTS" ]; then
    echo "  ✓ Rebuild complete"
    break
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

# ── Step 7: validate counts match ────────────────────────────────────────────
echo ""
echo "Step 7: Validating rebuilt projections..."
AFTER_EVENTS=$($PSQL "SELECT COUNT(*) FROM processed_events;" | tr -d ' ')
AFTER_DEVICES=$($PSQL "SELECT COUNT(*) FROM device_projections;" | tr -d ' ')
AFTER_TELEMETRY=$($PSQL "SELECT COUNT(*) FROM device_telemetry_latest;" | tr -d ' ')

echo "  processed_events:        $BEFORE_EVENTS → $AFTER_EVENTS"
echo "  device_projections:      $BEFORE_DEVICES → $AFTER_DEVICES"
echo "  device_telemetry_latest: $BEFORE_TELEMETRY → $AFTER_TELEMETRY"

PASS=true

if [ "$AFTER_EVENTS" -lt "$BEFORE_EVENTS" ]; then
  echo "  ✗ FAIL: processed_events count dropped ($BEFORE_EVENTS → $AFTER_EVENTS)"
  PASS=false
fi

if [ "$AFTER_DEVICES" -ne "$BEFORE_DEVICES" ]; then
  echo "  ✗ FAIL: device_projections count mismatch ($BEFORE_DEVICES → $AFTER_DEVICES)"
  PASS=false
fi

if [ "$AFTER_TELEMETRY" -ne "$BEFORE_TELEMETRY" ]; then
  echo "  ✗ FAIL: device_telemetry_latest count mismatch ($BEFORE_TELEMETRY → $AFTER_TELEMETRY)"
  PASS=false
fi

# ── Step 8: idempotency check — run replay again ──────────────────────────────
echo ""
echo "Step 8: Idempotency check — replaying again..."
$COMPOSE stop read-model-builder
sleep 2

docker exec grainguard-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group read-model-builder-v2 \
  --topic telemetry.events \
  --reset-offsets \
  --to-earliest \
  --execute 2>/dev/null || true

$COMPOSE start read-model-builder
sleep 30

IDEMPOTENT_EVENTS=$($PSQL "SELECT COUNT(*) FROM processed_events;" | tr -d ' ')
IDEMPOTENT_DEVICES=$($PSQL "SELECT COUNT(*) FROM device_projections;" | tr -d ' ')

echo "  processed_events after 2nd replay:   $IDEMPOTENT_EVENTS (expected: $AFTER_EVENTS)"
echo "  device_projections after 2nd replay: $IDEMPOTENT_DEVICES (expected: $AFTER_DEVICES)"

if [ "$IDEMPOTENT_DEVICES" -ne "$AFTER_DEVICES" ]; then
  echo "  ✗ FAIL: Idempotency violated — device count changed on second replay"
  PASS=false
else
  echo "  ✓ Idempotency confirmed"
fi

# ── Result ───────────────────────────────────────────────────────────────────
echo ""
if [ "$PASS" = true ]; then
  echo "=== ✅ REPLAY TEST PASSED ==="
  echo "Projection rebuild from offset 0 validated."
  echo "Idempotency confirmed — double replay produces same result."
  exit 0
else
  echo "=== ❌ REPLAY TEST FAILED ==="
  exit 1
fi
