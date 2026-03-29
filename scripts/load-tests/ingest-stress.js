import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const ingestLatency = new Trend("ingest_latency");

export const options = {
  stages: [
    { duration: "15s", target: 20 },
    { duration: "25s", target: 60 },
    { duration: "20s", target: 120 },
    { duration: "15s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.05"],
    checks: ["rate>0.95"],
    ingest_latency: ["p(95)<500"],
  },
};

const INGEST_URL = __ENV.INGEST_URL || "http://localhost:3001";
const API_KEY = __ENV.INGEST_API_KEY || "";
const DEVICE_IDS = (__ENV.DEVICE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

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

export default function () {
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
    "scripts/load-tests/results/ingest-stress-summary.json": JSON.stringify(
      data,
      null,
      2
    ),
  };
}
