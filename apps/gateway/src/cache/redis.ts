import Redis from "ioredis";

export const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
  lazyConnect: false,
  enableReadyCheck: true,
  connectTimeout: 5000,
});

redis.on("connect", () => {
  console.log("Redis connected");
});

redis.on("error", (err) => {
  console.error("Redis error:", err.message);
});

redis.on("close", () => {
  console.warn("Redis connection closed — will retry");
});

// Validate connectivity on startup
redis.ping().catch((err) => {
  console.error("Redis startup ping failed:", err.message);
  if (process.env.NODE_ENV === "production") {
    console.error("Redis is required in production — exiting");
    process.exit(1);
  }
});
