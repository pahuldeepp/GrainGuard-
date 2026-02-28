import { redis } from "../cache/redis";
import { pool } from "../database/db";
import {
  cacheHits,
  cacheMisses,
  cacheErrors,
} from "../observability/metrics";

export async function getDeviceLatestTelemetry(deviceId: string) {
  const cacheKey = `device:latest:${deviceId}`;

  try {
    // 1️⃣ Try Redis
    const cached = await redis.get(cacheKey);

    if (cached) {
      cacheHits.inc();
      return JSON.parse(cached);
    }

    cacheMisses.inc();

  } catch (err) {
    // Redis failed — don't crash request
    cacheErrors.inc();
    console.error("Redis GET failed:", err);
  }

  // 2️⃣ Query read DB
  const result = await pool.query(
    `
    SELECT device_id, temperature, humidity, recorded_at, updated_at
    FROM device_telemetry_latest
    WHERE device_id = $1
    `,
    [deviceId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  try {
    // 3️⃣ Cache result (5 min TTL)
    await redis.set(cacheKey, JSON.stringify(row), "EX", 300);
  } catch (err) {
    cacheErrors.inc();
    console.error("Redis SET failed:", err);
  }

  return row;
}