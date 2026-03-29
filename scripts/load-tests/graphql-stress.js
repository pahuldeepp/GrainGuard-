import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const gatewayLatency = new Trend("gateway_graphql_latency");

export const options = {
  stages: [
    { duration: "15s", target: 10 },
    { duration: "30s", target: 30 },
    { duration: "20s", target: 60 },
    { duration: "15s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.05"],
    checks: ["rate>0.95"],
    gateway_graphql_latency: ["p(95)<300"],
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || "http://localhost:8086";
const GRAPHQL_BODY = JSON.stringify({
  query:
    "query { devices(limit: 20) { deviceId serialNumber temperature humidity version } }",
});
const HEADERS = { "Content-Type": "application/json" };

export default function () {
  const response = http.post(`${GATEWAY_URL}/graphql`, GRAPHQL_BODY, {
    headers: HEADERS,
  });

  gatewayLatency.add(response.timings.duration);
  const ok = check(response, {
    "gateway graphql 200": (r) => r.status === 200,
    "gateway graphql devices": (r) => {
      try {
        const devices = JSON.parse(r.body).data.devices;
        return Array.isArray(devices);
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!ok);
  sleep(0.2);
}

export function handleSummary(data) {
  return {
    "scripts/load-tests/results/graphql-stress-summary.json": JSON.stringify(
      data,
      null,
      2
    ),
  };
}
