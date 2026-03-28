import { db } from "./datasources/postgres";
import { search } from "./datasources/elasticsearch";
import { cache } from "./datasources/redis";
import { pubsub, TELEMETRY_UPDATED, TENANT_TELEMETRY_UPDATED } from "./pubsub";
import type { BffContext } from "./server";
import { getTelemetryHistoryFromCassandra } from "./datasources/cassandra";

const TELEMETRY_TTL = 30;
const DEVICE_TTL   = 300;

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function requireIsoDate(value: unknown, field: string): string {
  const iso = toIsoDate(value);
  if (!iso) throw new Error(`Invalid ${field} value`);
  return iso;
}

/** Returns undefined (no filter) for superadmins, ctx.tenantId otherwise. */
function tenantFilter(ctx: BffContext): string | undefined {
  return ctx.isSuperAdmin ? undefined : ctx.tenantId;
}

/**
 * Non-blocking cache-miss helper.
 * If the lock is held by another request, do one immediate re-check rather
 * than sleeping 100 ms — avoids serialising all waiters behind a fixed delay.
 */
async function cacheGetOrLock<T>(
  key: string,
): Promise<{ cached: T | null; lockAcquired: string | null }> {
  const lockAcquired = await cache.acquireLock(key, 5);
  if (!lockAcquired) {
    const cached = await cache.get<T>(key);
    return { cached, lockAcquired: null };
  }
  return { cached: null, lockAcquired };
}

export const resolvers = {
  Query: {

    device: async (_: unknown, args: { deviceId: string }, ctx: BffContext) => {
      const cacheKey = `device:full:${ctx.tenantId}:${args.deviceId}`;
      const cached   = await cache.get<Record<string, unknown>>(cacheKey);
      if (cached) return cached;

      const row = await db.getDeviceWithTelemetry(args.deviceId);
      if (!row) return null;
      if (!ctx.isSuperAdmin && row.tenant_id !== ctx.tenantId) return null;

      const result = {
        deviceId:     row.device_id,
        tenantId:     row.tenant_id,
        serialNumber: row.serial_number,
        createdAt:    requireIsoDate(row.created_at, "created_at"),
        temperature:  row.temperature  ?? null,
        humidity:     row.humidity     ?? null,
        recordedAt:   toIsoDate(row.recorded_at),
        version:      row.version      ?? null,
      };
      await cache.set(cacheKey, result, DEVICE_TTL);
      return result;
    },

    devices: async (_: unknown, args: { limit?: number }, ctx: BffContext) => {
      const limit    = args.limit || 20;
      const tid      = tenantFilter(ctx);
      const cacheKey = `devices:all:${tid || "global"}:${limit}`;

      const cached = await cache.get<Record<string, unknown>[]>(cacheKey);
      if (cached) return cached;

      const rows   = await db.getAllDevicesWithTelemetry(limit, tid);
      const result = rows.map((row: Record<string, unknown>) => ({
        deviceId:     row.device_id,
        tenantId:     row.tenant_id,
        serialNumber: row.serial_number,
        createdAt:    requireIsoDate(row.created_at, "created_at"),
        temperature:  row.temperature  ?? null,
        humidity:     row.humidity     ?? null,
        recordedAt:   toIsoDate(row.recorded_at),
        version:      row.version      ?? null,
      }));
      await cache.set(cacheKey, result, DEVICE_TTL);
      return result;
    },

    /**
     * FIX (double query): tenant_id now lives on device_telemetry_latest so
     * one SELECT is enough — no second lookup through device_projections.
     * FIX (blocking sleep): replaced with a non-blocking immediate re-check.
     */
    deviceTelemetry: async (_: unknown, args: { deviceId: string }, ctx: BffContext) => {
      const cacheKey = `telemetry:device:${ctx.tenantId}:${args.deviceId}`;

      const cached = await cache.get<Record<string, unknown>>(cacheKey);
      if (cached) return cached;

      const { cached: retried, lockAcquired } =
        await cacheGetOrLock<Record<string, unknown>>(cacheKey);
      if (retried) return retried;

      try {
        const row = await db.getDeviceTelemetry(args.deviceId);
        if (!row) return null;
        // tenant_id is now returned by getDeviceTelemetry — one query, not two.
        if (!ctx.isSuperAdmin && row.tenant_id !== ctx.tenantId) return null;

        const result = {
          deviceId:    row.device_id,
          temperature: row.temperature ?? null,
          humidity:    row.humidity    ?? null,
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

    allTelemetry: async (_: unknown, args: { limit?: number }, ctx: BffContext) => {
      const limit    = args.limit || 20;
      const tid      = tenantFilter(ctx);
      const cacheKey = `telemetry:all:${tid || "global"}:${limit}`;

      const cached = await cache.get<Record<string, unknown>[]>(cacheKey);
      if (cached) return cached;

      const { cached: retried, lockAcquired } =
        await cacheGetOrLock<Record<string, unknown>[]>(cacheKey);
      if (retried) return retried;

      try {
        const rows   = await db.getAllTelemetry(limit, tid);
        const result = rows.map((row: Record<string, unknown>) => ({
          deviceId:    row.device_id,
          temperature: row.temperature ?? null,
          humidity:    row.humidity    ?? null,
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

    /**
     * FIX (N+1): was O(N) sequential DB queries for each cache miss.
     * Now: one batched SELECT … WHERE device_id = ANY($1) for all misses.
     * Tenant isolation is applied inside the batch query — no extra round-trip.
     */
    manyDeviceTelemetry: async (_: unknown, args: { deviceIds: string[] }, ctx: BffContext) => {
      if (args.deviceIds.length === 0) return [];

      const keys          = args.deviceIds.map(id => `telemetry:device:${ctx.tenantId}:${id}`);
      const cachedResults = await cache.getMany<Record<string, unknown>>(keys);

      const results: (Record<string, unknown> | null)[] = new Array(args.deviceIds.length).fill(null);
      const missedIds:     string[] = [];
      const missedIndexes: number[] = [];

      cachedResults.forEach((hit, i) => {
        if (hit) {
          results[i] = hit;
        } else {
          missedIds.push(args.deviceIds[i]);
          missedIndexes.push(i);
        }
      });

      if (missedIds.length > 0) {
        // Single batched query for ALL misses — replaces the O(N) loop.
        const rows   = await db.getManyDeviceTelemetry(missedIds, tenantFilter(ctx));
        const rowMap = new Map(rows.map(r => [r.device_id as string, r]));

        for (let i = 0; i < missedIds.length; i++) {
          const row = rowMap.get(missedIds[i]);
          if (!row) continue;

          const result = {
            deviceId:    row.device_id,
            temperature: row.temperature ?? null,
            humidity:    row.humidity    ?? null,
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

    deviceTelemetryHistory: async (
      _: unknown,
      args: { deviceId: string; limit?: number },
      ctx: BffContext,
    ) => {
      if (!ctx.isSuperAdmin) {
        const device = await db.getDeviceWithTelemetry(args.deviceId);
        if (!device || device.tenant_id !== ctx.tenantId) return [];
      }
      const limit = args.limit ?? 50;

      try {
        const cassRows = await getTelemetryHistoryFromCassandra(ctx.tenantId, args.deviceId, limit);
        if (cassRows.length > 0) {
          console.log("[history] served from Cassandra rows=" + cassRows.length);
          return cassRows;
        }
      } catch (err) {
        console.warn("[history] Cassandra unavailable, falling back to Postgres:", err);
      }

      console.log("[history] falling back to Postgres");
      const rows = await db.getTelemetryHistory(args.deviceId, limit, tenantFilter(ctx));
      return rows.map((row: Record<string, unknown>) => ({
        deviceId:    row.deviceId,
        temperature: row.temperature ?? null,
        humidity:    row.humidity    ?? null,
        recordedAt:  requireIsoDate(row.recordedAt, "recorded_at"),
      }));
    },

    devicesConnection: async (_: unknown, args: { first?: number; after?: string }, ctx: BffContext) => {
      const first = Math.min(args.first || 20, 100);
      return db.getDevicesWithCursor(first, args.after || null, tenantFilter(ctx));
    },

    searchDevices: async (_: unknown, args: { query: string; limit?: number }, ctx: BffContext) => {
      const q = (args.query || "").trim();
      if (q.length < 2) return [];
      return search.searchDevices(q, tenantFilter(ctx) || "", args.limit || 20);
    },
  },

  Subscription: {
    telemetryUpdated: {
      subscribe: (_: unknown, args: { deviceId: string }, ctx: BffContext) =>
        pubsub.asyncIterableIterator(`${TELEMETRY_UPDATED}:${ctx.tenantId}:${args.deviceId}`),
      resolve: (payload: unknown) => payload,
    },
    tenantTelemetryUpdated: {
      subscribe: (_: unknown, args: { tenantId: string }, ctx: BffContext) => {
        if (!ctx.isSuperAdmin && args.tenantId !== ctx.tenantId) {
          throw new Error("Unauthorized: cannot subscribe to another tenant");
        }
        return pubsub.asyncIterableIterator(`${TENANT_TELEMETRY_UPDATED}:${args.tenantId}`);
      },
      resolve: (payload: unknown) => payload,
    },
  },
};
