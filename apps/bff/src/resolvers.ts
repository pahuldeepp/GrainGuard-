import { db } from "./datasources/postgres";
import { search } from "./datasources/elasticsearch";
import { cache } from "./datasources/redis";
import { pubsub, TELEMETRY_UPDATED, TENANT_TELEMETRY_UPDATED } from "./pubsub";
import type { BffContext } from "./server";
import { getTelemetryHistoryFromCassandra } from "./datasources/cassandra";

const TELEMETRY_TTL = 30;
const DEVICE_TTL = 300;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string | number).toISOString();
}

/**
 * Tenant filter helper — superadmins can see all tenants.
 * Returns undefined (no filter) for superadmins, ctx.tenantId otherwise.
 */
function tenantFilter(ctx: BffContext): string | undefined {
  return ctx.isSuperAdmin ? undefined : ctx.tenantId;
}

export const resolvers = {
  Query: {

    device: async (_: any, args: { deviceId: string }, ctx: BffContext) => {
      const cacheKey = `device:full:${ctx.tenantId}:${args.deviceId}`;
      const cached = await cache.get<any>(cacheKey);
      if (cached) return cached;

      const row = await db.getDeviceWithTelemetry(args.deviceId);
      if (!row) return null;
      // Tenant isolation — superadmins bypass
      if (!ctx.isSuperAdmin && row.tenant_id !== ctx.tenantId) return null;

      const result = {
        deviceId:     row.device_id,
        tenantId:     row.tenant_id,
        serialNumber: row.serial_number,
        createdAt:    toIsoDate(row.created_at),
        temperature:  row.temperature || null,
        humidity:     row.humidity || null,
        recordedAt:   row.recorded_at ? toIsoDate(row.recorded_at) : null,
        version:      row.version || null,
      };

      await cache.set(cacheKey, result, DEVICE_TTL);
      return result;
    },

    devices: async (_: any, args: { limit?: number }, ctx: BffContext) => {
      const limit = args.limit || 20;
      const tid = tenantFilter(ctx);
      const cacheKey = `devices:all:${tid || "global"}:${limit}`;

      const cached = await cache.get<any[]>(cacheKey);
      if (cached) return cached;

      const rows = await db.getAllDevicesWithTelemetry(limit, tid);

      const result = rows.map((row: any) => ({
        deviceId:     row.device_id,
        tenantId:     row.tenant_id,
        serialNumber: row.serial_number,
        createdAt:    toIsoDate(row.created_at),
        temperature:  row.temperature || null,
        humidity:     row.humidity || null,
        recordedAt:   row.recorded_at ? toIsoDate(row.recorded_at) : null,
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

        // Tenant isolation check — superadmins bypass
        if (!ctx.isSuperAdmin) {
          const device = await db.getDeviceWithTelemetry(args.deviceId);
          if (!device || device.tenant_id !== ctx.tenantId) return null;
        }

        const result = {
          deviceId:    row.device_id,
          temperature: row.temperature,
          humidity:    row.humidity,
          recordedAt:  toIsoDate(row.recorded_at),
          updatedAt:   toIsoDate(row.updated_at),
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
      const tid = tenantFilter(ctx);
      const cacheKey = `telemetry:all:${tid || "global"}:${limit}`;

      const cached = await cache.get<any[]>(cacheKey);
      if (cached) return cached;

      const lockAcquired = await cache.acquireLock(cacheKey, 5);
      if (!lockAcquired) {
        await sleep(100);
        const retried = await cache.get<any[]>(cacheKey);
        if (retried) return retried;
      }

      try {
        const rows = await db.getAllTelemetry(limit, tid);

        const result = rows.map((row: any) => ({
          deviceId:    row.device_id,
          temperature: row.temperature,
          humidity:    row.humidity,
          recordedAt:  toIsoDate(row.recorded_at),
          updatedAt:   toIsoDate(row.updated_at),
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
          // Tenant isolation — superadmins bypass
          if (!ctx.isSuperAdmin) {
            const device = await db.getDeviceWithTelemetry(missedIds[i]);
            if (!device || device.tenant_id !== ctx.tenantId) continue;
          }

          const result = {
            deviceId:    row.device_id,
            temperature: row.temperature,
            humidity:    row.humidity,
            recordedAt:  toIsoDate(row.recorded_at),
            updatedAt:   toIsoDate(row.updated_at),
            version:     row.version,
          };
          await cache.set(keys[missedIndexes[i]], result, TELEMETRY_TTL);
          results[missedIndexes[i]] = result;
        }
      }

      return results.filter(Boolean);
    },

    deviceTelemetryHistory: async (_: any, args: { deviceId: string; limit?: number }, ctx: BffContext) => {
      // Tenant isolation — superadmins bypass
      if (!ctx.isSuperAdmin) {
        const device = await db.getDeviceWithTelemetry(args.deviceId);
        if (!device || device.tenant_id !== ctx.tenantId) return [];
      }
      const limit = args.limit ?? 50;

      try {
        const cassRows = await getTelemetryHistoryFromCassandra(ctx.tenantId, args.deviceId, limit);
        if (cassRows.length > 0) {
          console.log('[history] served from Cassandra rows=' + cassRows.length);
          return cassRows;
        }
      } catch (err) {
        console.warn('[history] Cassandra unavailable, falling back to Postgres:', err);
      }

      console.log('[history] falling back to Postgres');
      const tid = tenantFilter(ctx);
      const rows = await db.getTelemetryHistory(args.deviceId, limit, tid);
      return rows.map((row: any) => ({
        deviceId:    row.deviceId,
        temperature: row.temperature,
        humidity:    row.humidity,
        recordedAt:  toIsoDate(row.recordedAt),
      }));
    },
    devicesConnection: async (_: any, args: { first?: number; after?: string }, ctx: BffContext) => {
      const first = Math.min(args.first || 20, 100); // cap at 100
      const after = args.after || null;
      return db.getDevicesWithCursor(first, after, tenantFilter(ctx));
    },
    searchDevices: async (_: any, args: { query: string; limit?: number }, ctx: BffContext) => {
      const q = (args.query || "").trim();
      if (q.length < 2) return [];
      // Search: superadmins search all tenants
      const tid = tenantFilter(ctx);
      return search.searchDevices(q, tid || "", args.limit || 20);
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
        // Superadmins can subscribe to any tenant's updates
        if (!ctx.isSuperAdmin && args.tenantId !== ctx.tenantId) {
          throw new Error("Unauthorized: cannot subscribe to another tenant");
        }
        return pubsub.asyncIterableIterator(
          `${TENANT_TELEMETRY_UPDATED}:${args.tenantId}`
        );
      },
      resolve: (payload: any) => payload,
    },
  },
};
