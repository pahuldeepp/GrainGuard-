import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const queryDuration = new Trend('query_duration');

export const options = {
  stages: [
    { duration: '15s', target: 10 },
    { duration: '30s', target: 50 },
    { duration: '15s', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    errors: ['rate<0.01'],
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:8086';

export default function () {
  // Health check
  const healthRes = http.get(`${GATEWAY_URL}/health`);
  const ok = check(healthRes, {
    'health status 200': (r) => r.status === 200,
    'health returns ok': (r) => {
      try { return JSON.parse(r.body).status === 'ok'; }
      catch { return false; }
    },
    'health under 200ms': (r) => r.timings.duration < 200,
  });
  errorRate.add(!ok);
  queryDuration.add(healthRes.timings.duration);
  sleep(0.1);
}

export function handleSummary(data) {
  const { metrics } = data;
  const lines = [
    '\n=== GrainGuard Gateway Load Test Results ===',
    `p95 latency:  ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2)}ms`,
    `p99 latency:  ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2)}ms`,
    `error rate:   ${((metrics.errors?.values?.rate || 0) * 100).toFixed(2)}%`,
    `total reqs:   ${metrics.http_reqs?.values?.count}`,
    `req/s:        ${metrics.http_reqs?.values?.rate?.toFixed(2)}`,
    `============================================\n`,
  ];
  console.log(lines.join('\n'));
  return {
    'scripts/load-tests/results/gateway-summary.json': JSON.stringify(data, null, 2),
  };
}

