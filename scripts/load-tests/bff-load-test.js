import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const queryDuration = new Trend('query_duration');

export const options = {
  stages: [
    { duration: '30s', target: 10 },  // ramp up
    { duration: '60s', target: 50 },  // sustained load
    { duration: '30s', target: 100 }, // spike
    { duration: '30s', target: 0 },   // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const TENANT_ID = __ENV.TENANT_ID || '11111111-1111-1111-1111-111111111111';

const DEVICES_QUERY = JSON.stringify({
  query: `
    query GetDevices {
      devices {
        device_id
        serial_number
        temperature
        humidity
        recorded_at
        version
      }
    }
  `,
});

const DEVICE_QUERY = (deviceId) => JSON.stringify({
  query: `
    query GetDevice($id: ID!) {
      device(id: $id) {
        device_id
        serial_number
        temperature
        humidity
        recorded_at
        version
      }
    }
  `,
  variables: { id: deviceId },
});

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    'x-tenant-id': TENANT_ID,
  };

  // Test 1: List all devices
  const devicesRes = http.post(`${BASE_URL}/graphql`, DEVICES_QUERY, { headers });
  const devicesOk = check(devicesRes, {
    'devices status 200': (r) => r.status === 200,
    'devices has data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data && body.data.devices !== undefined;
      } catch { return false; }
    },
    'devices no errors': (r) => {
      try {
        const body = JSON.parse(r.body);
        return !body.errors;
      } catch { return false; }
    },
  });
  errorRate.add(!devicesOk);
  queryDuration.add(devicesRes.timings.duration);

  sleep(0.5);

  // Test 2: Health check
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health status 200': (r) => r.status === 200,
  });

  sleep(0.5);
}

export function handleSummary(data) {
  return {
    'scripts/load-tests/results/bff-load-test-summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, opts) {
  const { metrics } = data;
  const lines = [
    '\n=== GrainGuard BFF Load Test Results ===',
    `p95 latency:  ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2)}ms`,
    `p99 latency:  ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2)}ms`,
    `error rate:   ${(metrics.errors?.values?.rate * 100)?.toFixed(2)}%`,
    `total reqs:   ${metrics.http_reqs?.values?.count}`,
    `req/s:        ${metrics.http_reqs?.values?.rate?.toFixed(2)}`,
    '========================================\n',
  ];
  return lines.join('\n');
}
