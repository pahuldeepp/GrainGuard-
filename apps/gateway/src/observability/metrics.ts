import client from "prom-client";

const register = new client.Registry();

// Collect Node default metrics
client.collectDefaultMetrics({
  register,
  prefix: "gateway_",
});

// =====================
// Cache Metrics
// =====================

export const cacheHits = new client.Counter({
  name: "cache_hits_total",
  help: "Total cache hits from Redis",
  registers: [register],
});

export const cacheMisses = new client.Counter({
  name: "cache_misses_total",
  help: "Total cache misses from Redis",
  registers: [register],
});

export const cacheErrors = new client.Counter({
  name: "cache_errors_total",
  help: "Total Redis cache errors",
  registers: [register],
});

export const cacheInvalidations = new client.Counter({
  name: "cache_invalidation_total",
  help: "Total cache invalidations performed by gateway",
  registers: [register],
});

// =====================
// Metrics Handler
// =====================

export function metricsHandler() {
  return async (_req: any, res: any) => {
    try {
      res.setHeader("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).json({ error: "metrics_failed" });
    }
  };
}