import { createClient } from "redis";

const client = createClient({
  socket: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  }
});

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
    const results = await pipeline.exec();
    return results.map((r: any) => r ? JSON.parse(r) : null);
  },

  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  },

  async del(key: string): Promise<void> {
    await client.del(key);
  },

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    const lockKey = `lock:${key}`;
    const result = await client.set(lockKey, "1", { EX: ttlSeconds, NX: true });
    return result === "OK";
  },

  async releaseLock(key: string): Promise<void> {
    await client.del(`lock:${key}`);
  }
};
