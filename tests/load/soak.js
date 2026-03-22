/**
 * Soak test — sustained moderate load for 30 minutes.
 * Goal: catch memory leaks, connection pool exhaustion, slow degradation.
 *
 * Run: k6 run tests/load/soak.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BASE_URL, BFF_URL, HEADERS, THRESHOLDS, QUERIES, telemetryPayload } from './config.js';

const p99Latency    = new Trend('p99_latency');
const errorRate     = new Rate('error_rate');
const requestCount  = new Counter('total_requests');

export const options = {
  thresholds: {
    ...THRESHOLDS,
    // Soak-specific: p99 must stay under 2s throughout
    http_req_duration: ['p(99)<2000', 'p(95)<800'],
  },
  scenarios: {
    soak: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',  target: 25 },  // ramp up
        { duration: '26m', target: 25 },  // hold — sustained load
        { duration: '2m',  target: 0  },  // ramp down
      ],
    },
  },
};

export default function () {
  requestCount.add(1);

  // Rotate through realistic user actions
  const action = Math.random();

  if (action < 0.5) {
    // 50% — dashboard reads (most common)
    const res = http.post(`${BFF_URL}/graphql`, QUERIES.dashboard, { headers: HEADERS });
    p99Latency.add(res.timings.duration);
    errorRate.add(res.status !== 200);
    check(res, { 'dashboard ok': (r) => r.status === 200 });

  } else if (action < 0.8) {
    // 30% — device list reads
    const res = http.post(`${BFF_URL}/graphql`, QUERIES.deviceList, { headers: HEADERS });
    p99Latency.add(res.timings.duration);
    errorRate.add(res.status !== 200);
    check(res, { 'device list ok': (r) => r.status === 200 });

  } else {
    // 20% — telemetry ingest (write path)
    const res = http.post(
      `${BASE_URL}/api/v1/telemetry`,
      telemetryPayload(),
      { headers: HEADERS },
    );
    p99Latency.add(res.timings.duration);
    errorRate.add(res.status >= 500);
    check(res, { 'ingest ok': (r) => r.status === 200 || r.status === 202 });
  }

  sleep(1);
}

export function handleSummary(data) {
  return {
    'tests/load/results/soak-summary.json': JSON.stringify(data, null, 2),
  };
}
