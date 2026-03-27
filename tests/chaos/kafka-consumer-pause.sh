#!/usr/bin/env bash
# chaos/kafka-consumer-pause.sh
# Pauses Kafka consumer groups for read-model-builder and cdc-transformer,
# waits 60 s, resumes, then asserts consumer lag ≤ 10 000.
#
# Requires:
#   - kubectl with context set to target cluster
#   - kafka-consumer-groups.sh available (or kcat / kafkactl)
#   - NAMESPACE env var (default: grainguard-dev)
#   - KAFKA_BOOTSTRAP env var (default: kafka:9092 as seen inside cluster)

set -euo pipefail

NAMESPACE="${NAMESPACE:-grainguard-dev}"
KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:9092}"
PAUSE_SECONDS="${PAUSE_SECONDS:-60}"
MAX_LAG="${MAX_LAG:-10000}"
CONSUMERS=("read-model-builder" "cdc-transformer")
declare -A ORIGINAL_REPLICAS=()

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log()  { echo -e "${GREEN}[chaos]${NC} $*"; }
warn() { echo -e "${YELLOW}[chaos]${NC} $*"; }
fail() { echo -e "${RED}[chaos FAIL]${NC} $*" >&2; exit 1; }

# ── helpers ──────────────────────────────────────────────────────────────────

current_lag() {
  local group="$1"
  kubectl exec -n "$NAMESPACE" deploy/kafka -- \
    kafka-consumer-groups.sh \
      --bootstrap-server "$KAFKA_BOOTSTRAP" \
      --describe --group "$group" 2>/dev/null \
    | awk 'NR>1 && $NF~/[0-9]+/ { sum += $NF } END { print sum+0 }'
}

scale_consumer() {
  local deploy="$1" replicas="$2"
  kubectl scale deployment "$deploy" -n "$NAMESPACE" --replicas="$replicas"
}

current_replicas() {
  local deploy="$1"
  kubectl get deployment "$deploy" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}'
}

restore_consumers() {
  for consumer in "${CONSUMERS[@]}"; do
    local replicas="${ORIGINAL_REPLICAS[$consumer]:-1}"
    kubectl scale deployment "$consumer" -n "$NAMESPACE" --replicas="$replicas" >/dev/null 2>&1 || true
  done
}

cleanup() {
  restore_consumers
}

trap cleanup EXIT INT TERM

# ── steady-state: before ──────────────────────────────────────────────────────

log "=== Steady-state check BEFORE chaos ==="
for consumer in "${CONSUMERS[@]}"; do
  ORIGINAL_REPLICAS["$consumer"]="$(current_replicas "$consumer")"
  kubectl rollout status "deployment/$consumer" -n "$NAMESPACE" --timeout=30s \
    || fail "Consumer $consumer not healthy before chaos"
  log "  $consumer — healthy"
done

# ── action: pause consumers ───────────────────────────────────────────────────

log "=== Pausing consumers (scale to 0) ==="
for consumer in "${CONSUMERS[@]}"; do
  scale_consumer "$consumer" 0
  log "  Scaled $consumer → 0"
done

log "Sleeping ${PAUSE_SECONDS}s to allow lag to build..."
sleep "$PAUSE_SECONDS"

# Record lag while paused (informational)
for consumer in "${CONSUMERS[@]}"; do
  lag=$(current_lag "$consumer")
  warn "  Lag while paused — $consumer: $lag messages"
done

# ── action: resume consumers ──────────────────────────────────────────────────

log "=== Resuming consumers ==="
for consumer in "${CONSUMERS[@]}"; do
  replicas="${ORIGINAL_REPLICAS[$consumer]:-1}"
  scale_consumer "$consumer" "$replicas"
  log "  Scaled $consumer → $replicas"
done

log "Waiting for deployments to be ready..."
for consumer in "${CONSUMERS[@]}"; do
  kubectl rollout status "deployment/$consumer" -n "$NAMESPACE" --timeout=60s
done

# ── steady-state: after ───────────────────────────────────────────────────────

log "=== Steady-state check AFTER chaos (polling every 15s, up to 5 min) ==="
deadline=$(( $(date +%s) + 300 ))

for consumer in "${CONSUMERS[@]}"; do
  while true; do
    lag=$(current_lag "$consumer")
    log "  $consumer lag: $lag"
    if (( lag <= MAX_LAG )); then
      log "  ✓ $consumer caught up (lag=$lag ≤ $MAX_LAG)"
      break
    fi
    if (( $(date +%s) >= deadline )); then
      fail "$consumer lag $lag still > $MAX_LAG after 5 minutes — experiment FAILED"
    fi
    sleep 15
  done
done

trap - EXIT INT TERM

log "=== Kafka consumer pause experiment PASSED ==="
