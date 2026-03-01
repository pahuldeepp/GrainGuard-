import { redis } from "../cache/redis";
import { pool } from "../database/db";
import {
  cacheHits,
  cacheMisses,
  cacheErrors,
  redisLatency,
  dbLatency,
} from "../observability/metrics";
import {
  recordFailure,
  recordSuccess,
  allowRequest,
} from "./cacheBreaker";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getDeviceLatestTelemetry(deviceId: string) {
  const versionKey = `device:${deviceId}:latest_version`;
  const lockKey = `lock:device:${deviceId}`;
  const lockTtlSeconds = 4;
  const waitMs = 75;
  const maxWaitLoops = 10;

  /* -----------------------------
     1️⃣ Try Redis (breaker aware)
  ------------------------------*/
  if (allowRequest()) {
    try {
      const redisTimer = redisLatency.startTimer();

      const version = await redis.get(versionKey);

      if (version) {
        const cached = await redis.get(`device:${deviceId}:v${version}`);
        redisTimer();

        if (cached) {
          recordSuccess();
          cacheHits.inc();
          return JSON.parse(cached);
        }
      } else {
        redisTimer();
      }

      cacheMisses.inc();
    } catch (err) {
      recordFailure();
      cacheErrors.inc();
      console.error("Redis GET failed:", err);
    }
  } else {
    cacheMisses.inc();
  }

  /* -----------------------------
     2️⃣ Acquire stampede lock
  ------------------------------*/
  let lockAcquired = false;
  const lockValue = `${process.pid}-${Date.now()}`;

  if (allowRequest()) {
    try {
      const res = await redis.set(lockKey, lockValue, "NX", "EX", lockTtlSeconds);
      lockAcquired = res === "OK";
    } catch (err) {
      recordFailure();
      cacheErrors.inc();
      console.error("Redis LOCK failed:", err);
      return queryDbAndReturn(deviceId);
    }
  } else {
    return queryDbAndReturn(deviceId);
  }

  /* -----------------------------
     3️⃣ Wait if another request owns lock
  ------------------------------*/
  if (!lockAcquired) {
    for (let i = 0; i < maxWaitLoops; i++) {
      await sleep(waitMs);

      if (!allowRequest()) break;

      try {
        const redisTimer = redisLatency.startTimer();

        const version = await redis.get(versionKey);
        if (!version) {
          redisTimer();
          continue;
        }

        const cached = await redis.get(`device:${deviceId}:v${version}`);
        redisTimer();

        if (cached) {
          recordSuccess();
          cacheHits.inc();
          return JSON.parse(cached);
        }
      } catch (err) {
        recordFailure();
        cacheErrors.inc();
        console.error("Redis retry failed:", err);
        break;
      }
    }

    return queryDbAndReturn(deviceId);
  }

  /* -----------------------------
     4️⃣ Lock owner → DB → update cache
  ------------------------------*/
  try {
    const row = await queryDbAndReturn(deviceId);
    if (!row) return null;

    const version = row.version;
    const versionedKey = `device:${deviceId}:v${version}`;

    if (allowRequest()) {
      try {
        const redisTimer = redisLatency.startTimer();

        await redis.set(versionedKey, JSON.stringify(row), "EX", 300);
        await redis.set(versionKey, version.toString(), "EX", 300);

        redisTimer();
        recordSuccess();
      } catch (err) {
        recordFailure();
        cacheErrors.inc();
        console.error("Redis SET failed:", err);
      }
    }

    return row;
  } finally {
    // Release lock only if we still own it (Lua atomic check-and-delete)
    if (allowRequest()) {
      try {
        const luaRelease = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        await redis.eval(luaRelease, 1, lockKey, lockValue);
      } catch (err) {
        recordFailure();
        cacheErrors.inc();
        console.error("Redis UNLOCK failed:", err);
      }
    }
  }
}

/* -----------------------------
   DB QUERY (with latency metric)
------------------------------*/
async function queryDbAndReturn(deviceId: string) {
  const dbTimer = dbLatency.startTimer();

  const result = await pool.query(
    `
    SELECT device_id, temperature, humidity, recorded_at, updated_at, version
    FROM device_telemetry_latest
    WHERE device_id = $1
    `,
    [deviceId]
  );

  dbTimer();

  return result.rows.length ? result.rows[0] : null;
}