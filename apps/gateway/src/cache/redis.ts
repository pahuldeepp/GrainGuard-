import Redis, { Cluster } from "ioredis";

// REDIS_CLUSTER_NODES = "redis-node-1:6379,redis-node-2:6379,..."
// When set, uses Redis Cluster. Otherwise falls back to single-node (local dev).
const REDIS_CLUSTER_NODES = process.env.REDIS_CLUSTER_NODES;

function createClient(): Redis | Cluster {
  if (REDIS_CLUSTER_NODES) {
    const nodes = REDIS_CLUSTER_NODES.split(",").map((n) => {
      const [host, port] = n.trim().split(":");
      return { host, port: parseInt(port || "6379") };
    });
    console.log(`Redis cluster mode: ${nodes.length} nodes`);
    return new Redis.Cluster(nodes, {
      redisOptions: {
        connectTimeout: 5000,
        maxRetriesPerRequest: 3,
      },
      clusterRetryStrategy: (times) => Math.min(times * 200, 5000),
      enableReadyCheck: true,
      scaleReads: "slave", // distribute reads to replicas
    });
  }

  // Single-node (local dev / docker-compose default)
  console.log("Redis single-node mode");
  return new Redis({
    host: process.env.REDIS_HOST || "redis",
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: false,
    enableReadyCheck: true,
    connectTimeout: 5000,
  });
}

export const redis = createClient();

redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (err: Error) => console.error("Redis error:", err.message));
redis.on("close", () => console.warn("Redis connection closed — will retry"));

// Validate on startup — fail-fast in production
(redis as any).ping().catch((err: Error) => {
  console.error("Redis startup ping failed:", err.message);
  if (process.env.NODE_ENV === "production") {
    console.error("Redis is required in production — exiting");
    process.exit(1);
  }
});
