import { createClient, createCluster } from "redis";

// REDIS_CLUSTER_NODES = "redis-cluster-0:6379,redis-cluster-1:6379,..."
// When set, uses Redis Cluster. Otherwise falls back to single-node (local dev).
const REDIS_CLUSTER_NODES = process.env.REDIS_CLUSTER_NODES;

const client = (() => {
  if (REDIS_CLUSTER_NODES) {
    const rootNodes = REDIS_CLUSTER_NODES.split(",").map((n) => {
      const [host, port] = n.trim().split(":");
      return {
        url: `redis://${host}:${parseInt(port || "6379", 10)}`,
      };
    });
    console.log(`Redis cluster mode: ${rootNodes.length} nodes`);
    return createCluster({ rootNodes });
  }

  // Single-node (local dev / docker-compose default)
  console.log("Redis single-node mode");
  return createClient({
    socket: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
    },
  });
})();

client.connect().catch(console.error);
client.on("error", (err) => console.error("Redis error:", err));
client.on("connect", () => console.log("Redis connected"));

export const cache = {

  async get<T>(key: string): Promise<T | null> {
    const value = await client.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  },

  async getMany<T>(keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) return [];
    const pipeline = client.multi();
    keys.forEach(key => pipeline.get(key));
    const results = await pipeline.exec() as (string | null)[];
    return results.map((r) => (r ? JSON.parse(r) as T : null));
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  },

  async del(key: string): Promise<void> {
    await client.del(key);
  },

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const lockKey = `lock:${key}`;
    const token = Math.random().toString(36).slice(2);
    const result = await client.set(lockKey, token, { EX: ttlSeconds, NX: true });
    return result === "OK" ? token : null;
  },

  async releaseLock(key: string, token?: string): Promise<void> {
    const lockKey = `lock:${key}`;
    if (!token) {
      await client.del(lockKey);
      return;
    }
    // Atomic compare-and-delete — only release if we own the lock
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await client.eval(script, { keys: [lockKey], arguments: [token] });
  }
};
