/**
 * Spike test — sudden 10x traffic burst, then back to baseline.
 * Goal: verify the system doesn't crash and recovers cleanly.
 *
 * Run: k6 run tests/load/spike.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, BFF_URL, HEADERS, THRESHOLDS, QUERIES, telemetryPayload } from './config.js';

const gatewayLatency  = new Trend('gateway_latency');
const ingestLatency   = new Trend('ingest_latency');
const errorRate       = new Rate('error_rate');

export const options = {
  thresholds: THRESHOLDS,
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10  },  // warm up
        { duration: '30s', target: 10  },  // baseline
        { duration: '10s', target: 100 },  // spike!
        { duration: '1m',  target: 100 },  // hold spike
        { duration: '10s', target: 10  },  // recover
        { duration: '30s', target: 10  },  // verify recovery
        { duration: '10s', target: 0   },  // ramp down
      ],
    },
  },
};

export default function () {
  // 1. Dashboard query (read path)
  const dashRes = http.post(
    `${BFF_URL}/graphql`,
    QUERIES.dashboard,
    { headers: HEADERS },
  );
  gatewayLatency.add(dashRes.timings.duration);
  errorRate.add(dashRes.status !== 200);
  check(dashRes, {
    'dashboard 200': (r) => r.status === 200,
    'dashboard has data': (r) => {
      try { return JSON.parse(r.body).data !== null; } catch { return false; }
    },
  });

  // 2. Telemetry ingest (write path)
  const ingestRes = http.post(
    `${BASE_URL}/api/v1/telemetry`,
    telemetryPayload(),
    { headers: HEADERS },
  );
  ingestLatency.add(ingestRes.timings.duration);
  errorRate.add(ingestRes.status >= 500);
  check(ingestRes, {
    'ingest accepted': (r) => r.status === 200 || r.status === 202,
  });

  sleep(1);
}
