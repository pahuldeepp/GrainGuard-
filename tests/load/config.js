// Shared config for all k6 load tests
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const BFF_URL  = __ENV.BFF_URL  || 'http://localhost:4000';

// Pass/fail thresholds — these gate CI
export const THRESHOLDS = {
  // 99th percentile latency under 1s
  http_req_duration: ['p(99)<1000', 'p(95)<500'],
  // Error rate under 1%
  http_req_failed: ['rate<0.01'],
  // At least 95% of checks must pass
  checks: ['rate>0.95'],
};

// Shared headers
export const HEADERS = {
  'Content-Type': 'application/json',
  'x-tenant-id': __ENV.TENANT_ID || 'tenant-load-test',
  'Authorization': `Bearer ${__ENV.TEST_TOKEN || 'test-token'}`,
};

// GraphQL queries
export const QUERIES = {
  dashboard: JSON.stringify({
    query: `query Dashboard($tenantId: ID!) {
      dashboardSummary(tenantId: $tenantId) {
        totalDevices
        activeAlerts
        avgRiskScore
      }
    }`,
    variables: { tenantId: 'tenant-load-test' },
  }),

  deviceList: JSON.stringify({
    query: `query Devices($tenantId: ID!) {
      devices(tenantId: $tenantId, limit: 20) {
        id
        name
        status
        lastSeen
      }
    }`,
    variables: { tenantId: 'tenant-load-test' },
  }),
};

// Telemetry payload factory
export function telemetryPayload(deviceId) {
  return JSON.stringify({
    deviceId: deviceId || `device-${Math.floor(Math.random() * 1000)}`,
    tenantId: 'tenant-load-test',
    temperature: 20 + Math.random() * 10,
    humidity: 40 + Math.random() * 20,
    co2: 400 + Math.random() * 100,
    timestamp: new Date().toISOString(),
  });
}
