import { db } from "./datasources/postgres";
import { cache } from "./datasources/redis";

const TELEMETRY_TTL = 30;
const DEVICE_TTL = 300; // 5 minutes — device metadata changes rarely
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const resolvers = {
  Query: {

    // Queries device_projections + device_telemetry_latest in one JOIN
    // This is what makes the BFF powerful — one GraphQL call, two DB tables
    device: async (_: any, args: { deviceId: string }) => {
      const cacheKey = `device:full:${args.deviceId}`;

      const cached = await cache.get<any>(cacheKey);
      if (cached) {
        console.log(`Cache HIT for ${cacheKey}`);
        return cached;
      }

      console.log(`Cache MISS for ${cacheKey} - querying Postgres`);
      const row = await db.getDeviceWithTelemetry(args.deviceId);
      if (!row) return null;

      const result = {
        deviceId:     row.device_id,
        tenantId:     row.tenant_id,
        serialNumber: row.serial_number,
        createdAt:    new Date(row.created_at).toISOString(),
        temperature:  row.temperature || null,
        humidity:     row.humidity || null,
        recordedAt:   row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
        version:      row.version || null,
      };

      await cache.set(cacheKey, result, DEVICE_TTL);
      return result;
    },

    // All devices with telemetry
    devices: async (_: any, args: { limit?: number }) => {
      const limit = args.limit || 20;
      const cacheKey = `devices:all:${limit}`;

      const cached = await cache.get<any[]>(cacheKey);
      if (cached) {
        console.log(`Cache HIT for ${cacheKey}`);
        return cached;
      }

      console.log(`Cache MISS for ${cacheKey} - querying Postgres`);
      const rows = await db.getAllDevicesWithTelemetry(limit);

      const result = rows.map((row: any) => ({
        deviceId:     row.device_id,
        tenantId:     row.tenant_id,
        serialNumber: row.serial_number,
        createdAt:    new Date(row.created_at).toISOString(),
        temperature:  row.temperature || null,
        humidity:     row.humidity || null,
        recordedAt:   row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
        version:      row.version || null,
      }));

      await cache.set(cacheKey, result, DEVICE_TTL);
      return result;
    },

    // Telemetry only
    deviceTelemetry: async (_: any, args: { deviceId: string }) => {
      const cacheKey = `telemetry:device:${args.deviceId}`;

      const cached = await cache.get<any>(cacheKey);
      if (cached) {
        console.log(`Cache HIT for ${cacheKey}`);
        return cached;
      }

      const lockAcquired = await cache.acquireLock(cacheKey, 5);
      if (!lockAcquired) {
        await sleep(100);
        const retried = await cache.get<any>(cacheKey);
        if (retried) return retried;
      }

      try {
        console.log(`Cache MISS for ${cacheKey} - querying Postgres`);
        const row = await db.getDeviceTelemetry(args.deviceId);
        if (!row) return null;

        const result = {
          deviceId:    row.device_id,
          temperature: row.temperature,
          humidity:    row.humidity,
          recordedAt:  new Date(row.recorded_at).toISOString(),
          updatedAt:   new Date(row.updated_at).toISOString(),
          version:     row.version,
        };

        await cache.set(cacheKey, result, TELEMETRY_TTL);
        return result;
      } finally {
        if (lockAcquired) await cache.releaseLock(cacheKey);
      }
    },

    allTelemetry: async (_: any, args: { limit?: number }) => {
      const limit = args.limit || 20;
      const cacheKey = `telemetry:all:${limit}`;

      const cached = await cache.get<any[]>(cacheKey);
      if (cached) {
        console.log(`Cache HIT for ${cacheKey}`);
        return cached;
      }

      const lockAcquired = await cache.acquireLock(cacheKey, 5);
      if (!lockAcquired) {
        await sleep(100);
        const retried = await cache.get<any[]>(cacheKey);
        if (retried) return retried;
      }

      try {
        console.log(`Cache MISS for ${cacheKey} - querying Postgres`);
        const rows = await db.getAllTelemetry(limit);

        const result = rows.map((row: any) => ({
          deviceId:    row.device_id,
          temperature: row.temperature,
          humidity:    row.humidity,
          recordedAt:  new Date(row.recorded_at).toISOString(),
          updatedAt:   new Date(row.updated_at).toISOString(),
          version:     row.version,
        }));

        await cache.set(cacheKey, result, TELEMETRY_TTL);
        return result;
      } finally {
        if (lockAcquired) await cache.releaseLock(cacheKey);
      }
    },

    manyDeviceTelemetry: async (_: any, args: { deviceIds: string[] }) => {
      const keys = args.deviceIds.map(id => `telemetry:device:${id}`);
      const cachedResults = await cache.getMany<any>(keys);

      const results: any[] = [];
      const missedIds: string[] = [];
      const missedIndexes: number[] = [];

      cachedResults.forEach((result, i) => {
        if (result) {
          results[i] = result;
        } else {
          missedIds.push(args.deviceIds[i]);
          missedIndexes.push(i);
        }
      });

      for (let i = 0; i < missedIds.length; i++) {
        const row = await db.getDeviceTelemetry(missedIds[i]);
        if (row) {
          const result = {
            deviceId:    row.device_id,
            temperature: row.temperature,
            humidity:    row.humidity,
            recordedAt:  new Date(row.recorded_at).toISOString(),
            updatedAt:   new Date(row.updated_at).toISOString(),
            version:     row.version,
          };
          await cache.set(keys[missedIndexes[i]], result, TELEMETRY_TTL);
          results[missedIndexes[i]] = result;
        }
      }

      return results.filter(Boolean);
    },
  },
};