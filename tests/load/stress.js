/**
 * Stress test — ramp load until the system breaks, find the limit.
 * Goal: identify breaking point, verify graceful degradation (not hard crash).
 *
 * Run: k6 run tests/load/stress.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, BFF_URL, HEADERS, QUERIES, telemetryPayload } from './config.js';

const latency   = new Trend('stress_latency');
const errorRate = new Rate('error_rate');

export const options = {
  // Stress test: we expect it to degrade — thresholds are more lenient
  thresholds: {
    http_req_failed: ['rate<0.10'],   // tolerate up to 10% errors
    http_req_duration: ['p(95)<3000'], // p95 under 3s
    checks: ['rate>0.85'],
  },
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m',  target: 50  },  // warm up
        { duration: '5m',  target: 50  },  // baseline
        { duration: '2m',  target: 100 },  // increase
        { duration: '5m',  target: 100 },  // hold
        { duration: '2m',  target: 200 },  // heavy load
        { duration: '5m',  target: 200 },  // hold
        { duration: '2m',  target: 300 },  // near limit
        { duration: '5m',  target: 300 },  // hold
        { duration: '5m',  target: 0   },  // recovery — must recover
      ],
    },
  },
};

export default function () {
  const action = Math.random();

  if (action < 0.6) {
    const res = http.post(`${BFF_URL}/graphql`, QUERIES.dashboard, { headers: HEADERS });
    latency.add(res.timings.duration);
    errorRate.add(res.status >= 500);
    check(res, {
      'not 5xx': (r) => r.status < 500,
    });
  } else {
    const res = http.post(
      `${BASE_URL}/api/v1/telemetry`,
      telemetryPayload(),
      { headers: HEADERS },
    );
    latency.add(res.timings.duration);
    errorRate.add(res.status >= 500);
    check(res, {
      'ingest not 5xx': (r) => r.status < 500,
    });
  }

  sleep(0.5);
}

export function handleSummary(data) {
  return {
    'tests/load/results/stress-summary.json': JSON.stringify(data, null, 2),
  };
}
