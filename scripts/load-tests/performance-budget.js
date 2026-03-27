// k6 performance budget test
// Runs spike + soak scenarios against the gateway and BFF.
// CI fails if any threshold is breached — prevents latency regressions from merging.
//
// Run locally:
//   k6 run --env GATEWAY_URL=http://localhost:3000 \
//          --env BFF_URL=http://localhost:8086 \
//          --env JWT=<token> \
//          scripts/load-tests/performance-budget.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// ── Custom metrics ────────────────────────────────────────────────────────────
const gatewayP95   = new Trend("gateway_p95_ms", true);
const bffP95       = new Trend("bff_p95_ms", true);
const errorRate    = new Rate("error_rate");
const totalErrors  = new Counter("total_errors");

const GATEWAY_URL = __ENV.GATEWAY_URL ?? "http://localhost:3000";
const BFF_URL     = __ENV.BFF_URL     ?? "http://localhost:8086";
const JWT         = __ENV.JWT         ?? "";

// ── Thresholds (performance budget) ──────────────────────────────────────────
// If any threshold fails, k6 exits with code 99 and CI marks the step as failed.
export const options = {
  thresholds: {
    // Gateway REST: 95th percentile < 500ms
    "http_req_duration{endpoint:gateway}": ["p(95)<500"],
    // BFF GraphQL: 95th percentile < 800ms (GraphQL is heavier)
    "http_req_duration{endpoint:bff}": ["p(95)<800"],
    // Error rate must stay below 1%
    "error_rate": ["rate<0.01"],
    // Custom trends for reporting
    "gateway_p95_ms": ["p(95)<500"],
    "bff_p95_ms": ["p(95)<800"],
  },

  scenarios: {
    // Baseline: steady 50 RPS for 2 minutes
    baseline: {
      executor:       "constant-arrival-rate",
      rate:           50,
      timeUnit:       "1s",
      duration:       "2m",
      preAllocatedVUs:60,
      maxVUs:         100,
    },

    // Spike: ramp from 0 to 200 VU in 30s, hold 30s, ramp down
    spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 200 },
        { duration: "30s", target: 200 },
        { duration: "30s", target: 0 },
      ],
      startTime: "2m",   // starts after baseline finishes
    },
  },
};

const COMMON_HEADERS = {
  Authorization:  `Bearer ${JWT}`,
  "Content-Type": "application/json",
};

// ── Virtual user script ───────────────────────────────────────────────────────
export default function () {
  // 1. Gateway: GET /health (cheapest — warms up)
  const healthRes = http.get(`${GATEWAY_URL}/health`, { tags: { endpoint: "gateway" } });
  check(healthRes, { "gateway /health 200": (r) => r.status === 200 });
  gatewayP95.add(healthRes.timings.duration);

  // 2. Gateway: GET /devices/:id/latest (requires JWT)
  if (JWT) {
    const devRes = http.get(
      `${GATEWAY_URL}/devices/00000000-0000-0000-0000-000000000001/latest`,
      { headers: COMMON_HEADERS, tags: { endpoint: "gateway" } }
    );
    // 404 is acceptable — device may not exist in test env
    const ok = devRes.status === 200 || devRes.status === 404;
    if (!ok) {
      errorRate.add(1);
      totalErrors.add(1);
    } else {
      errorRate.add(0);
    }
    gatewayP95.add(devRes.timings.duration);
  }

  // 3. BFF: GraphQL query for devices
  if (JWT) {
    const gqlRes = http.post(
      `${BFF_URL}/graphql`,
      JSON.stringify({
        query: `{ devices(first: 10) { edges { node { id serialNumber temperature } } } }`,
      }),
      { headers: COMMON_HEADERS, tags: { endpoint: "bff" } }
    );

    let gqlErrors = false;
    try {
      const body = gqlRes.json();
      gqlErrors = Array.isArray(body?.errors) && body.errors.length > 0;
    } catch {
      gqlErrors = true;
    }

    const bffOk = gqlRes.status === 200 && !gqlErrors;
    check(gqlRes, { "bff graphql 200": () => bffOk });
    if (!bffOk) {
      errorRate.add(1);
      totalErrors.add(1);
    } else {
      errorRate.add(0);
    }
    bffP95.add(gqlRes.timings.duration);
  }

  sleep(0.1); // 100ms think time between requests
}

// ── Summary output ────────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    // Write JSON summary for CI artifact upload
    "scripts/load-tests/results/performance-budget-summary.json": JSON.stringify(data, null, 2),
    stdout: `
=== Performance Budget Summary ===
Gateway p95: ${data.metrics["gateway_p95_ms"]?.values?.["p(95)"]?.toFixed(0) ?? "N/A"} ms  (budget: 500ms)
BFF p95:     ${data.metrics["bff_p95_ms"]?.values?.["p(95)"]?.toFixed(0) ?? "N/A"} ms  (budget: 800ms)
Error rate:  ${((data.metrics["error_rate"]?.values?.rate ?? 0) * 100).toFixed(2)}%  (budget: <1%)
`,
  };
}
