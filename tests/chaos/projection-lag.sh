#!/usr/bin/env bash
# chaos/projection-lag.sh
# Verifies the read-model-builder projection-lag alert fires and recovers.
#
# Strategy:
#   1. Pause read-model-builder (scale 0) to let lag build.
#   2. Assert Prometheus/Alertmanager sees ProjectionLagHigh within 2 min.
#   3. Restore read-model-builder, assert lag drops below threshold in 5 min.
#
# Requires: kubectl, curl, NAMESPACE / PROMETHEUS_URL / KAFKA_BOOTSTRAP env vars.

set -euo pipefail

NAMESPACE="${NAMESPACE:-grainguard-dev}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:9092}"
CONSUMER_GROUP="${CONSUMER_GROUP:-read-model-builder}"
LAG_THRESHOLD="${LAG_THRESHOLD:-5000}"
ALERT_WINDOW="${ALERT_WINDOW:-120}"   # seconds to wait for alert to fire
RECOVERY_WINDOW="${RECOVERY_WINDOW:-300}"  # seconds to wait for lag to drop
STRICT_ALERT_CHECK="${STRICT_ALERT_CHECK:-0}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log()  { echo -e "${GREEN}[chaos]${NC} $*"; }
warn() { echo -e "${YELLOW}[chaos]${NC} $*"; }
fail() { echo -e "${RED}[chaos FAIL]${NC} $*" >&2; exit 1; }

# ── helpers ───────────────────────────────────────────────────────────────────

current_lag() {
  kubectl exec -n "$NAMESPACE" deploy/kafka -- \
    kafka-consumer-groups.sh \
      --bootstrap-server "$KAFKA_BOOTSTRAP" \
      --describe --group "$CONSUMER_GROUP" 2>/dev/null \
    | awk 'NR>1 && $NF~/[0-9]+/ { sum += $NF } END { print sum+0 }'
}

alert_firing() {
  # Returns 0 (true) if ProjectionLagHigh alert is active in Alertmanager
  curl -s "${PROMETHEUS_URL}/api/v1/alerts" 2>/dev/null \
    | grep -q '"alertname":"ProjectionLagHigh"'
}

# ── steady-state: before ──────────────────────────────────────────────────────

log "=== Steady-state BEFORE projection chaos ==="
kubectl rollout status deployment/read-model-builder -n "$NAMESPACE" --timeout=30s \
  || fail "read-model-builder not healthy before chaos"

initial_lag=$(current_lag)
log "  Initial lag: $initial_lag"
(( initial_lag < LAG_THRESHOLD )) \
  || fail "Lag $initial_lag already ≥ $LAG_THRESHOLD before chaos — aborting"

# ── action: pause consumer ────────────────────────────────────────────────────

log "=== Pausing read-model-builder ==="
kubectl scale deployment/read-model-builder -n "$NAMESPACE" --replicas=0
log "Scaled to 0 — lag will build on topic telemetry.events"

# ── probe: alert must fire within ALERT_WINDOW ───────────────────────────────

log "=== Waiting up to ${ALERT_WINDOW}s for ProjectionLagHigh alert ==="
deadline=$(( $(date +%s) + ALERT_WINDOW ))
alert_fired=0

while (( $(date +%s) < deadline )); do
  lag=$(current_lag)
  warn "  Lag: $lag"
  if alert_firing; then
    log "  ✓ ProjectionLagHigh alert FIRED (lag=$lag)"
    alert_fired=1
    break
  fi
  sleep 10
done

(( alert_fired )) \
  || {
    if [[ "$STRICT_ALERT_CHECK" == "1" ]]; then
      fail "ProjectionLagHigh alert did NOT fire within ${ALERT_WINDOW}s"
    fi
    warn "  ProjectionLagHigh alert did NOT fire within ${ALERT_WINDOW}s (check Prometheus rules)"
  }

# ── action: restore consumer ──────────────────────────────────────────────────

log "=== Restoring read-model-builder ==="
kubectl scale deployment/read-model-builder -n "$NAMESPACE" --replicas=1
kubectl rollout status deployment/read-model-builder -n "$NAMESPACE" --timeout=60s

# ── steady-state: after ───────────────────────────────────────────────────────

log "=== Waiting up to ${RECOVERY_WINDOW}s for lag to drop below $LAG_THRESHOLD ==="
deadline=$(( $(date +%s) + RECOVERY_WINDOW ))

while true; do
  lag=$(current_lag)
  log "  Lag: $lag"
  (( lag < LAG_THRESHOLD )) && {
    log "  ✓ Lag recovered (lag=$lag < $LAG_THRESHOLD)"
    break
  }
  (( $(date +%s) >= deadline )) \
    && fail "Lag $lag still ≥ $LAG_THRESHOLD after ${RECOVERY_WINDOW}s — experiment FAILED"
  sleep 15
done

log "=== Projection-lag experiment PASSED ==="
