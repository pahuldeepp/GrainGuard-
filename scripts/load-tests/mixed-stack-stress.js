import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const gatewayLatency = new Trend("gateway_graphql_latency");
const ingestLatency = new Trend("ingest_latency");

export const options = {
  scenarios: {
    graphql_readers: {
      executor: "ramping-vus",
      exec: "graphqlReader",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 10 },
        { duration: "25s", target: 30 },
        { duration: "20s", target: 50 },
        { duration: "15s", target: 0 },
      ],
    },
    ingest_writers: {
      executor: "ramping-vus",
      exec: "ingestWriter",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 20 },
        { duration: "25s", target: 50 },
        { duration: "20s", target: 80 },
        { duration: "15s", target: 0 },
      ],
      startTime: "5s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.08"],
    checks: ["rate>0.92"],
    gateway_graphql_latency: ["p(95)<400"],
    ingest_latency: ["p(95)<600"],
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || "http://localhost:8086";
const INGEST_URL = __ENV.INGEST_URL || "http://localhost:3001";
const API_KEY = __ENV.INGEST_API_KEY || "";
const DEVICE_IDS = (__ENV.DEVICE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const GRAPHQL_BODY = JSON.stringify({
  query:
    "query { devices(limit: 20) { deviceId serialNumber temperature humidity version } }",
});

if (!API_KEY) {
  throw new Error("INGEST_API_KEY is required");
}

if (DEVICE_IDS.length === 0) {
  throw new Error("DEVICE_IDS must contain at least one UUID");
}

function buildPayload(deviceId) {
  return JSON.stringify({
    serialNumber: deviceId,
    temperature: 20 + Math.random() * 15,
    humidity: 35 + Math.random() * 35,
    timestamp: new Date().toISOString(),
  });
}

export function graphqlReader() {
  const response = http.post(`${GATEWAY_URL}/graphql`, GRAPHQL_BODY, {
    headers: { "Content-Type": "application/json" },
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

export function ingestWriter() {
  const deviceId = DEVICE_IDS[__ITER % DEVICE_IDS.length];
  const response = http.post(`${INGEST_URL}/ingest`, buildPayload(deviceId), {
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY,
    },
  });

  ingestLatency.add(response.timings.duration);
  const ok = check(response, {
    "ingest accepted": (r) => r.status === 202,
    "ingest acknowledged": (r) => {
      try {
        return JSON.parse(r.body).accepted === true;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!ok);
  sleep(0.1);
}

export function handleSummary(data) {
  return {
    "scripts/load-tests/results/mixed-stack-stress-summary.json": JSON.stringify(
      data,
      null,
      2
    ),
  };
}
