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

const GATEWAY_URL = __ENV.GATEWAY_URL || "http://localhost:3000";
const BFF_URL = __ENV.BFF_URL || "http://localhost:8086";
const JWT = __ENV.JWT || "";
const TEST_DEVICE_ID =
  __ENV.TEST_DEVICE_ID || "00000000-0000-0000-0000-000000000001";
const DEV_TENANT_ID =
  __ENV.DEV_TENANT_ID || "11111111-1111-1111-1111-111111111111";
const GATEWAY_AUTH_DISABLED = (__ENV.GATEWAY_AUTH_DISABLED || "false") === "true";
const BFF_AUTH_DISABLED = (__ENV.BFF_AUTH_DISABLED || "false") === "true";
const GATEWAY_SAMPLE_PATH = __ENV.GATEWAY_SAMPLE_PATH || "";
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || "0.1");
const BASELINE_RATE = Number(__ENV.BASELINE_RATE || "50");
const BASELINE_DURATION = __ENV.BASELINE_DURATION || "2m";
const BASELINE_PREALLOCATED_VUS = Number(__ENV.BASELINE_PREALLOCATED_VUS || "60");
const BASELINE_MAX_VUS = Number(__ENV.BASELINE_MAX_VUS || "100");
const SPIKE_TARGET = Number(__ENV.SPIKE_TARGET || "200");
const SPIKE_RAMP_UP = __ENV.SPIKE_RAMP_UP || "30s";
const SPIKE_HOLD = __ENV.SPIKE_HOLD || "30s";
const SPIKE_RAMP_DOWN = __ENV.SPIKE_RAMP_DOWN || "30s";

function gatewayHeaders() {
  if (JWT) return { Authorization: `Bearer ${JWT}` };
  if (GATEWAY_AUTH_DISABLED) return { "x-tenant-id": DEV_TENANT_ID };
  return {};
}

function graphqlHeaders() {
  if (JWT) return COMMON_HEADERS;
  if (BFF_AUTH_DISABLED) {
    return {
      "Content-Type": "application/json",
      "x-tenant-id": DEV_TENANT_ID,
    };
  }
  return { "Content-Type": "application/json" };
}

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
    baseline: {
      executor:       "constant-arrival-rate",
      rate:           BASELINE_RATE,
      timeUnit:       "1s",
      duration:       BASELINE_DURATION,
      preAllocatedVUs:BASELINE_PREALLOCATED_VUS,
      maxVUs:         BASELINE_MAX_VUS,
    },

    spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: SPIKE_RAMP_UP, target: SPIKE_TARGET },
        { duration: SPIKE_HOLD, target: SPIKE_TARGET },
        { duration: SPIKE_RAMP_DOWN, target: 0 },
      ],
      startTime: BASELINE_DURATION,
    },
  },
};

const COMMON_HEADERS = {
  Authorization:  `Bearer ${JWT}`,
  "Content-Type": "application/json",
};

function recordResult(ok) {
  errorRate.add(ok ? 0 : 1);
  if (!ok) {
    totalErrors.add(1);
  }
}

function hasGraphqlErrors(response) {
  try {
    const body = response.json();
    return Array.isArray(body?.errors) && body.errors.length > 0;
  } catch (error) {
    return true;
  }
}

// ── Virtual user script ───────────────────────────────────────────────────────
export default function () {
  // 1. Gateway: GET /health (cheapest — warms up)
  const healthRes = http.get(`${GATEWAY_URL}/health`, { tags: { endpoint: "gateway" } });
  const healthOk = healthRes.status === 200;
  check(healthRes, { "gateway /health 200": () => healthOk });
  recordResult(healthOk);
  gatewayP95.add(healthRes.timings.duration);

  // 2. Gateway: hit a deterministic route that matches the environment.
  if (GATEWAY_SAMPLE_PATH) {
    const gatewaySampleRes = http.get(
      `${GATEWAY_URL}${GATEWAY_SAMPLE_PATH}`,
      { tags: { endpoint: "gateway" } }
    );
    const ok = gatewaySampleRes.status === 200;
    check(gatewaySampleRes, { "gateway sample ok": () => ok });
    recordResult(ok);
    gatewayP95.add(gatewaySampleRes.timings.duration);
  } else if (JWT || GATEWAY_AUTH_DISABLED) {
    const devRes = http.get(
      `${GATEWAY_URL}/devices/${TEST_DEVICE_ID}/latest`,
      { headers: gatewayHeaders(), tags: { endpoint: "gateway" } }
    );
    const ok = devRes.status === 200 || devRes.status === 404;
    recordResult(ok);
    gatewayP95.add(devRes.timings.duration);
  }

  // 3. BFF: GraphQL telemetry query
  if (JWT || BFF_AUTH_DISABLED) {
    const gqlRes = http.post(
      `${BFF_URL}/graphql`,
      JSON.stringify({
        query: `
          query($deviceId: String!) {
            deviceTelemetry(deviceId: $deviceId) {
              deviceId
              temperature
              humidity
              version
            }
          }
        `,
        variables: {
          deviceId: TEST_DEVICE_ID,
        },
      }),
      { headers: graphqlHeaders(), tags: { endpoint: "bff" } }
    );

    const bffOk = gqlRes.status === 200 && !hasGraphqlErrors(gqlRes);
    check(gqlRes, { "bff graphql ok": () => bffOk });
    recordResult(bffOk);
    bffP95.add(gqlRes.timings.duration);
  }

  sleep(THINK_TIME_SECONDS);
}

// ── Summary output ────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const gatewayMetric = data.metrics["gateway_p95_ms"];
  const bffMetric = data.metrics["bff_p95_ms"];
  const errorMetric = data.metrics["error_rate"];
  const gatewayP95Value =
    gatewayMetric &&
    gatewayMetric.values &&
    gatewayMetric.values["p(95)"] !== undefined
      ? gatewayMetric.values["p(95)"].toFixed(0)
      : "N/A";
  const bffP95Value =
    bffMetric &&
    bffMetric.values &&
    bffMetric.values["p(95)"] !== undefined
      ? bffMetric.values["p(95)"].toFixed(0)
      : "N/A";
  const errorRateValue =
    errorMetric && errorMetric.values && errorMetric.values.rate !== undefined
      ? (errorMetric.values.rate * 100).toFixed(2)
      : "0.00";

  return {
    // Write JSON summary for CI artifact upload
    "scripts/load-tests/results/performance-budget-summary.json": JSON.stringify(data, null, 2),
    stdout: `
=== Performance Budget Summary ===
Gateway p95: ${gatewayP95Value} ms  (budget: 500ms)
BFF p95:     ${bffP95Value} ms  (budget: 800ms)
Error rate:  ${errorRateValue}%  (budget: <1%)
`,
  };
}
