import client from "prom-client";
import type { Request, Response } from "express";

const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

export const graphqlOperations = new client.Counter({
  name: "graphql_operations_total",
  help: "Total GraphQL operations",
  labelNames: ["operation", "status"],
  registers: [register],
});

export function metricsHandler() {
  return async (_req: Request, res: Response) => {
    res.setHeader("Content-Type", register.contentType);
    res.end(await register.metrics());
  };
}
