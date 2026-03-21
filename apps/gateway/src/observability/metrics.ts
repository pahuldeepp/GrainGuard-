// review-sweep
import client from "prom-client";

const register = new client.Registry();

client.collectDefaultMetrics({
  register,
  prefix: "gateway_",
});

/* ------------------------
   CACHE METRICS
------------------------- */

export const cacheHits = new client.Counter({
  name: "cache_hits_total",
  help: "Total cache hits",
  registers: [register],
});

export const cacheMisses = new client.Counter({
  name: "cache_misses_total",
  help: "Total cache misses",
  registers: [register],
});

export const cacheErrors = new client.Counter({
  name: "cache_errors_total",
  help: "Total Redis errors",
  registers: [register],
});

/* ------------------------
   LATENCY HISTOGRAMS
------------------------- */

// Redis latency
export const redisLatency = new client.Histogram({
  name: "gateway_redis_duration_seconds",
  help: "Redis operation latency",
  buckets: [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1],
  registers: [register],
});

// DB latency
export const dbLatency = new client.Histogram({
  name: "gateway_db_duration_seconds",
  help: "Database query latency",
  buckets: [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [register],
});

// Request latency
export const requestLatency = new client.Histogram({
  name: "gateway_request_duration_seconds",
  help: "Total HTTP request duration",
  buckets: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

/* ------------------------
   METRICS HANDLER
------------------------- */

export function metricsHandler() {
  return async (_req: any, res: any) => {
    res.setHeader("Content-Type", register.contentType);
    res.end(await register.metrics());
  };
}