#!/usr/bin/env bash
# chaos/redis-outage.sh
# Simulates a Redis outage by scaling the Redis deployment to 0.
# Verifies:
#   1. GraphQL stays healthy while BFF falls back to Postgres
#   2. Saga-orchestrator avoids panic / fatal crashes during the outage
#   3. Redis is restored cleanly after the test
#
# Requires: kubectl, curl (or httpie), NAMESPACE / GATEWAY_URL env vars.

set -euo pipefail

NAMESPACE="${NAMESPACE:-grainguard-dev}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3000}"
OUTAGE_SECONDS="${OUTAGE_SECONDS:-45}"
REDIS_DEPLOY="${REDIS_DEPLOY:-redis}"
ORIGINAL_REPLICAS=""
REDIS_SCALED_DOWN=0

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log()  { echo -e "${GREEN}[chaos]${NC} $*"; }
warn() { echo -e "${YELLOW}[chaos]${NC} $*"; }
fail() { echo -e "${RED}[chaos FAIL]${NC} $*" >&2; exit 1; }

GRAPHQL_QUERY='{"query":"{ devices(limit: 5) { deviceId serialNumber } }"}'

restore_redis() {
  if [[ "$REDIS_SCALED_DOWN" != "1" ]] || [[ -z "$ORIGINAL_REPLICAS" ]]; then
    return
  fi

  warn "Restoring Redis deployment to ${ORIGINAL_REPLICAS} replicas"
  kubectl scale deployment "$REDIS_DEPLOY" -n "$NAMESPACE" --replicas="$ORIGINAL_REPLICAS" >/dev/null 2>&1 || true
  kubectl rollout status "deployment/$REDIS_DEPLOY" -n "$NAMESPACE" --timeout=60s >/dev/null 2>&1 || true
}
trap restore_redis EXIT

http_check() {
  local label="$1"
  local status
  local body_file
  body_file="$(mktemp)"
  status=$(curl -s -w "%{http_code}" \
    -X POST "$GATEWAY_URL/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TEST_JWT:-dummy-jwt}" \
    -d "$GRAPHQL_QUERY" \
    -o "$body_file" 2>/dev/null || echo "000")
  if [[ "$status" == "200" ]] \
    && grep -q '"data"' "$body_file" \
    && ! grep -q '"errors"' "$body_file"; then
    log "  ✓ $label — HTTP $status"
    rm -f "$body_file"
  else
    warn "  ✗ $label — HTTP $status"
    if [[ -s "$body_file" ]]; then
      warn "    body: $(tr '\n' ' ' < "$body_file")"
    fi
    rm -f "$body_file"
    return 1
  fi
}

# ── steady-state: before ──────────────────────────────────────────────────────

log "=== Steady-state BEFORE Redis outage ==="
kubectl rollout status "deployment/$REDIS_DEPLOY" -n "$NAMESPACE" --timeout=30s \
  || fail "Redis not healthy before chaos"
ORIGINAL_REPLICAS="$(kubectl get deployment "$REDIS_DEPLOY" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')"
[[ -n "$ORIGINAL_REPLICAS" ]] || fail "Unable to determine Redis replica count"

http_check "GraphQL devices query before outage" \
  || fail "BFF not responding before chaos"

# ── action: kill Redis ────────────────────────────────────────────────────────

log "=== Scaling Redis to 0 ==="
kubectl scale deployment "$REDIS_DEPLOY" -n "$NAMESPACE" --replicas=0
REDIS_SCALED_DOWN=1
log "Redis scaled to 0 — outage begins"

sleep 5  # let connections time-out / be noticed by BFF

# ── probe: BFF falls back to DB ───────────────────────────────────────────────

log "=== Verifying BFF DB fallback (10 attempts, 3s apart) ==="
fallback_ok=0
for i in $(seq 1 10); do
  if http_check "Attempt $i (Redis down)"; then
    fallback_ok=1
    break
  fi
  sleep 3
done

(( fallback_ok )) || fail "BFF did not fall back to DB during Redis outage"

# ── probe: saga-orchestrator logs — no crash ─────────────────────────────────

log "=== Checking saga-orchestrator for panics during outage ==="
sleep 5
panic_count=$(kubectl logs -n "$NAMESPACE" deploy/saga-orchestrator \
  --since="${OUTAGE_SECONDS}s" 2>/dev/null \
  | grep -c "panic\|FATAL\|unhandled" || true)
(( panic_count == 0 )) \
  || fail "saga-orchestrator logged $panic_count panic/fatal lines during outage"
log "  ✓ saga-orchestrator — no panics"

log "Waiting remaining outage window (${OUTAGE_SECONDS}s total)..."
remaining=$(( OUTAGE_SECONDS - 15 ))
if (( remaining > 0 )); then
  sleep "$remaining"
fi

# ── action: restore Redis ─────────────────────────────────────────────────────

log "=== Restoring Redis ==="
kubectl scale deployment "$REDIS_DEPLOY" -n "$NAMESPACE" --replicas="$ORIGINAL_REPLICAS"
kubectl rollout status "deployment/$REDIS_DEPLOY" -n "$NAMESPACE" --timeout=60s
REDIS_SCALED_DOWN=0

# ── steady-state: after ───────────────────────────────────────────────────────

log "=== Steady-state AFTER Redis restore ==="
sleep 5
http_check "GraphQL devices query after restore" \
  || fail "BFF not responding after Redis restore"

# Warm-up check: second request should be cache-hit (fast)
t_start=$(date +%s%N)
http_check "Cache warm-up probe"
t_end=$(date +%s%N)
elapsed_ms=$(( (t_end - t_start) / 1000000 ))
log "  Response time after restore: ${elapsed_ms}ms"

log "=== Redis outage experiment PASSED ==="
