import { db } from "./datasources/postgres";
import { search } from "./datasources/elasticsearch";
import { cache } from "./datasources/redis";
import { pubsub, TELEMETRY_UPDATED, TENANT_TELEMETRY_UPDATED } from "./pubsub";
import type { BffContext } from "./server";

const TELEMETRY_TTL = 30;
const DEVICE_TTL = 300;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const resolvers = {
  Query: {

    device: async (_: any, args: { deviceId: string }, ctx: BffContext) => {
      const cacheKey = `device:full:${ctx.tenantId}:${args.deviceId}`;
      const cached = await cache.get<any>(cacheKey);
      if (cached) return cached;

      const row = await db.getDeviceWithTelemetry(args.deviceId);
      if (!row) return null;
      if (row.tenant_id !== ctx.tenantId) return null;

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

    devices: async (_: any, args: { limit?: number }, ctx: BffContext) => {
      const limit = args.limit || 20;
      const cacheKey = `devices:all:${ctx.tenantId}:${limit}`;

      const cached = await cache.get<any[]>(cacheKey);
      if (cached) return cached;

      const rows = await db.getAllDevicesWithTelemetry(limit, ctx.tenantId);

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

    deviceTelemetry: async (_: any, args: { deviceId: string }, ctx: BffContext) => {
      const cacheKey = `telemetry:device:${ctx.tenantId}:${args.deviceId}`;

      const cached = await cache.get<any>(cacheKey);
      if (cached) return cached;

      const lockAcquired = await cache.acquireLock(cacheKey, 5);
      if (!lockAcquired) {
        await sleep(100);
        const retried = await cache.get<any>(cacheKey);
        if (retried) return retried;
      }

      try {
        const row = await db.getDeviceTelemetry(args.deviceId);
        if (!row) return null;

        const device = await db.getDeviceWithTelemetry(args.deviceId);
        if (!device || device.tenant_id !== ctx.tenantId) return null;

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

    allTelemetry: async (_: any, args: { limit?: number }, ctx: BffContext) => {
      const limit = args.limit || 20;
      const cacheKey = `telemetry:all:${ctx.tenantId}:${limit}`;

      const cached = await cache.get<any[]>(cacheKey);
      if (cached) return cached;

      const lockAcquired = await cache.acquireLock(cacheKey, 5);
      if (!lockAcquired) {
        await sleep(100);
        const retried = await cache.get<any[]>(cacheKey);
        if (retried) return retried;
      }

      try {
        const rows = await db.getAllTelemetry(limit, ctx.tenantId);

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

    manyDeviceTelemetry: async (_: any, args: { deviceIds: string[] }, ctx: BffContext) => {
      const keys = args.deviceIds.map(id => `telemetry:device:${ctx.tenantId}:${id}`);
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
          const device = await db.getDeviceWithTelemetry(missedIds[i]);
          if (!device || device.tenant_id !== ctx.tenantId) continue;

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

    deviceTelemetryHistory: async (_: any, args: { deviceId: string; limit?: number }, ctx: BffContext) => {
      const device = await db.getDeviceWithTelemetry(args.deviceId);
      if (!device || device.tenant_id !== ctx.tenantId) return [];

      const rows = await db.getTelemetryHistory(args.deviceId, args.limit ?? 50);
      return rows.map((row: any) => ({
        deviceId:    row.deviceId,
        temperature: row.temperature,
        humidity:    row.humidity,
        recordedAt:  new Date(row.recordedAt).toISOString(),
      }));
    },
    searchDevices: async (_: any, args: { query: string; limit?: number }, ctx: BffContext) => {
      const q = (args.query || "").trim();
      if (q.length < 2) return [];
      return search.searchDevices(q, ctx.tenantId, args.limit || 20);
    },
  },
  Subscription: {
    telemetryUpdated: {
      subscribe: (_: any, args: { deviceId: string }, ctx: BffContext) => {
        return pubsub.asyncIterableIterator(
          `${TELEMETRY_UPDATED}:${ctx.tenantId}:${args.deviceId}`
        );
      },
      resolve: (payload: any) => payload,
    },

    tenantTelemetryUpdated: {
      subscribe: (_: any, args: { tenantId: string }, ctx: BffContext) => {
        if (args.tenantId !== ctx.tenantId) {
          throw new Error("Unauthorized: cannot subscribe to another tenant");
        }
        return pubsub.asyncIterableIterator(
          `${TENANT_TELEMETRY_UPDATED}:${ctx.tenantId}`
        );
      },
      resolve: (payload: any) => payload,
    },
  },
};
