#!/usr/bin/env bash
# chaos/run-all.sh
# Run the full chaos suite sequentially.
# Exits 0 only if ALL experiments pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"
mkdir -p "$RESULTS_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${GREEN}[suite]${NC} $*"; }
fail() { echo -e "${RED}[suite FAIL]${NC} $*" >&2; }

PASSED=()
FAILED=()

run_chaos() {
  local name="$1"
  local cmd=("${@:2}")
  local logfile="${RESULTS_DIR}/${name}.log"

  log "━━━ Running: $name ━━━"
  if "${cmd[@]}" 2>&1 | tee "$logfile"; then
    PASSED+=("$name")
    log "${GREEN}✓ PASSED${NC}: $name"
  else
    FAILED+=("$name")
    fail "✗ FAILED: $name (see $logfile)"
  fi
  echo ""
}

# ── Experiments ────────────────────────────────────────────────────────────────

run_chaos "pod-kill" \
  chaos run "${SCRIPT_DIR}/pod-kill.yaml"

run_chaos "kafka-consumer-pause" \
  bash "${SCRIPT_DIR}/kafka-consumer-pause.sh"

run_chaos "redis-outage" \
  bash "${SCRIPT_DIR}/redis-outage.sh"

run_chaos "projection-lag" \
  bash "${SCRIPT_DIR}/projection-lag.sh"

run_chaos "network-partition" \
  chaos run "${SCRIPT_DIR}/network-partition.yaml"

# ── Summary ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}━━━ Chaos Suite Summary ━━━${NC}"
echo -e "  ${GREEN}Passed (${#PASSED[@]}):${NC} ${PASSED[*]:-none}"
echo -e "  ${RED}Failed (${#FAILED[@]}):${NC} ${FAILED[*]:-none}"

if (( ${#FAILED[@]} > 0 )); then
  echo -e "${RED}SUITE FAILED${NC}"
  exit 1
fi

echo -e "${GREEN}SUITE PASSED${NC}"
exit 0
