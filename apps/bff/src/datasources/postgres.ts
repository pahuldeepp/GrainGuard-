import { Pool } from "pg";
import { postgresCircuitBreaker } from "../lib/circuitBreaker";
import { cache } from "./redis";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true for valid UUID v4 strings — guards against bad JWT claims */
export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const pool = new Pool({
  connectionString:
    process.env.READ_DATABASE_URL ||
    `postgres://${process.env.READ_DB_USER ?? "postgres"}:${process.env.READ_DB_PASSWORD ?? "postgres"}@${process.env.READ_DB_HOST ?? "postgres-read"}:${process.env.READ_DB_PORT ?? "5432"}/${process.env.READ_DB_NAME ?? "grainguard_read"}`,
  max: 50,
});

type Row = Record<string, unknown>;
type QueryResult = import("pg").QueryResult<Row>;

// Circuit-breaker-wrapped query helper
async function cbQuery(text: string, values?: unknown[]): Promise<QueryResult> {
  return postgresCircuitBreaker.execute(() => pool.query(text, values as unknown[]));
}

// Tenant-scoped query — sets app.current_tenant_id for RLS enforcement
export async function tenantQuery(
  tenantId: string,
  text: string,
  values?: unknown[]
): Promise<QueryResult> {
  return postgresCircuitBreaker.execute(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId]
      );
      const result = await client.query(
        text,
        values as unknown[] | undefined
      ) as QueryResult;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Release the client even if rollback fails.
      }
      throw error;
    } finally {
      client.release();
    }
  });
}

export const db = {

  async getDevice(deviceId: string) {
    const result = await cbQuery(
      `SELECT device_id, tenant_id, serial_number, created_at
       FROM device_projections
       WHERE device_id = $1`,
      [deviceId]
    );
    return result.rows[0] || null;
  },

  async getAllDevices(limit: number = 20) {
    const cacheKey = `devices:all:${limit}`;
    const cached = await cache.get<Row[]>(cacheKey);
    if (cached) return cached;

    const locked = await cache.acquireLock(cacheKey, 5);
    if (!locked) {
      await new Promise(r => setTimeout(r, 100));
      return await cache.get<Row[]>(cacheKey) || [];
    }

    try {
      const result = await cbQuery(
        `SELECT device_id, tenant_id, serial_number, created_at
         FROM device_projections
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      await cache.set(cacheKey, result.rows, 30);
      return result.rows;
    } finally {
      await cache.releaseLock(cacheKey);
    }
  },

  async getDeviceTelemetry(deviceId: string) {
    const result = await cbQuery(
      `SELECT device_id, temperature, humidity, recorded_at, updated_at, version
       FROM device_telemetry_latest
       WHERE device_id = $1`,
      [deviceId]
    );
    return result.rows[0] || null;
  },

  async getAllTelemetry(limit: number = 20, tenantId?: string) {
    const cacheKey = `telemetry:all:${tenantId || "global"}:${limit}`;
    const cached = await cache.get<Row[]>(cacheKey);
    if (cached) return cached;

    const locked = await cache.acquireLock(cacheKey, 5);
    if (!locked) {
      await new Promise(r => setTimeout(r, 100));
      return await cache.get<Row[]>(cacheKey) || [];
    }

    try {
      if (tenantId) {
        const result = await cbQuery(
          `SELECT t.device_id, t.temperature, t.humidity, t.recorded_at, t.updated_at, t.version
           FROM device_telemetry_latest t
           INNER JOIN device_projections d ON d.device_id = t.device_id
           WHERE d.tenant_id = $1
           ORDER BY t.updated_at DESC
           LIMIT $2`,
          [tenantId, limit]
        );
        await cache.set(cacheKey, result.rows, 30);
        return result.rows;
      }

      const result = await cbQuery(
        `SELECT device_id, temperature, humidity, recorded_at, updated_at, version
         FROM device_telemetry_latest
         ORDER BY updated_at DESC
         LIMIT $1`,
        [limit]
      );
      await cache.set(cacheKey, result.rows, 30);
      return result.rows;
    } finally {
      await cache.releaseLock(cacheKey);
    }
  },

  async getDeviceWithTelemetry(deviceId: string) {
    const result = await cbQuery(
      `SELECT
         d.device_id,
         d.tenant_id,
         d.serial_number,
         d.created_at,
         t.temperature,
         t.humidity,
         t.recorded_at,
         t.version
       FROM device_projections d
       LEFT JOIN device_telemetry_latest t
         ON d.device_id = t.device_id
       WHERE d.device_id = $1`,
      [deviceId]
    );
    return result.rows[0] || null;
  },

  async getTelemetryHistory(deviceId: string, limit = 50, tenantId?: string) {
    const queryFn = tenantId
      ? (text: string, values: unknown[]) => tenantQuery(tenantId, text, values)
      : cbQuery;
    const result = await queryFn(
      `SELECT device_id, temperature, humidity, recorded_at
       FROM device_telemetry_history
       WHERE device_id = $1
       ORDER BY recorded_at ASC
       LIMIT $2`,
      [deviceId, limit]
    );
    return result.rows.map((r: Row) => ({
      deviceId:    r.device_id,
      temperature: r.temperature,
      humidity:    r.humidity,
      recordedAt:  r.recorded_at,
    }));
  },

  async getAllDevicesWithTelemetry(limit: number = 20, tenantId?: string) {
    const cacheKey = `devices:telemetry:${tenantId || "global"}:${limit}`;
    const cached = await cache.get<Row[]>(cacheKey);
    if (cached) return cached;

    const locked = await cache.acquireLock(cacheKey, 5);
    if (!locked) {
      await new Promise(r => setTimeout(r, 100));
      return await cache.get<Row[]>(cacheKey) || [];
    }

    try {
      if (tenantId) {
        const result = await cbQuery(
          `SELECT
             d.device_id, d.tenant_id, d.serial_number, d.created_at,
             t.temperature, t.humidity, t.recorded_at, t.version
           FROM device_projections d
           LEFT JOIN device_telemetry_latest t ON d.device_id = t.device_id
           WHERE d.tenant_id = $1
           ORDER BY d.created_at DESC
           LIMIT $2`,
          [tenantId, limit]
        );
        await cache.set(cacheKey, result.rows, 30);
        return result.rows;
      }

      const result = await cbQuery(
        `SELECT
           d.device_id, d.tenant_id, d.serial_number, d.created_at,
           t.temperature, t.humidity, t.recorded_at, t.version
         FROM device_projections d
         LEFT JOIN device_telemetry_latest t ON d.device_id = t.device_id
         ORDER BY d.created_at DESC
         LIMIT $1`,
        [limit]
      );
      await cache.set(cacheKey, result.rows, 30);
      return result.rows;
    } finally {
      await cache.releaseLock(cacheKey);
    }
  },

  async getDevicesWithCursor(first: number = 20, after: string | null = null, tenantId?: string) {
    let afterTimestamp: string | null = null;
    if (after) {
      try {
        afterTimestamp = Buffer.from(after, "base64").toString("utf-8");
      } catch {
        afterTimestamp = null;
      }
    }

    const fetchLimit = first + 1;
    let rows: Row[];

    if (tenantId && afterTimestamp) {
      const result = await cbQuery(
        `SELECT d.device_id, d.tenant_id, d.serial_number, d.created_at,
                t.temperature, t.humidity, t.recorded_at, t.version
         FROM device_projections d
         LEFT JOIN device_telemetry_latest t ON d.device_id = t.device_id
         WHERE d.tenant_id = $1 AND d.created_at < $2
         ORDER BY d.created_at DESC
         LIMIT $3`,
        [tenantId, afterTimestamp, fetchLimit]
      );
      rows = result.rows;
    } else if (tenantId) {
      const result = await cbQuery(
        `SELECT d.device_id, d.tenant_id, d.serial_number, d.created_at,
                t.temperature, t.humidity, t.recorded_at, t.version
         FROM device_projections d
         LEFT JOIN device_telemetry_latest t ON d.device_id = t.device_id
         WHERE d.tenant_id = $1
         ORDER BY d.created_at DESC
         LIMIT $2`,
        [tenantId, fetchLimit]
      );
      rows = result.rows;
    } else {
      const result = await cbQuery(
        `SELECT d.device_id, d.tenant_id, d.serial_number, d.created_at,
                t.temperature, t.humidity, t.recorded_at, t.version
         FROM device_projections d
         LEFT JOIN device_telemetry_latest t ON d.device_id = t.device_id
         ORDER BY d.created_at DESC
         LIMIT $1`,
        [fetchLimit]
      );
      rows = result.rows;
    }

    const hasNextPage = rows.length > first;
    const items = hasNextPage ? rows.slice(0, first) : rows;

    let totalCount = 0;
    if (tenantId) {
      const countResult = await cbQuery(
        "SELECT COUNT(*) FROM device_projections WHERE tenant_id = $1",
        [tenantId]
      );
      totalCount = parseInt(countResult.rows[0].count as string, 10);
    } else {
      const countResult = await cbQuery("SELECT COUNT(*) FROM device_projections");
      totalCount = parseInt(countResult.rows[0].count as string, 10);
    }

    const edges = items.map((row: Row) => ({
      cursor: Buffer.from((row.created_at as Date).toISOString()).toString("base64"),
      node: {
        deviceId:     row.device_id,
        tenantId:     row.tenant_id,
        serialNumber: row.serial_number,
        createdAt:    new Date(row.created_at as string).toISOString(),
        temperature:  row.temperature ?? null,
        humidity:     row.humidity ?? null,
        recordedAt:   row.recorded_at ? new Date(row.recorded_at as string).toISOString() : null,
        version:      row.version ?? null,
      },
    }));

    return {
      edges,
      totalCount,
      pageInfo: {
        hasNextPage,
        hasPreviousPage: !!after,
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor:   edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
    };
  },

  async createDevice(input: { serialNumber: string; tenantId: string }) {
    const result = await cbQuery(
      `INSERT INTO device_projections (device_id, tenant_id, serial_number, created_at)
       VALUES (gen_random_uuid(), $1, $2, NOW())
       RETURNING device_id, tenant_id, serial_number, created_at`,
      [input.tenantId, input.serialNumber]
    );
    return {
      deviceId:     result.rows[0].device_id,
      tenantId:     result.rows[0].tenant_id,
      serialNumber: result.rows[0].serial_number,
      createdAt:    new Date(result.rows[0].created_at as string).toISOString(),
    };
  },

  async updateDevice(deviceId: string, input: { serialNumber?: string }) {
    const result = await cbQuery(
      `UPDATE device_projections
       SET serial_number = COALESCE($1, serial_number)
       WHERE device_id = $2
       RETURNING device_id, tenant_id, serial_number, created_at`,
      [input.serialNumber || null, deviceId]
    );
    return {
      deviceId:     result.rows[0].device_id,
      tenantId:     result.rows[0].tenant_id,
      serialNumber: result.rows[0].serial_number,
      createdAt:    new Date(result.rows[0].created_at as string).toISOString(),
    };
  },

  async deleteDevice(deviceId: string) {
    await cbQuery(
      `DELETE FROM device_projections WHERE device_id = $1`,
      [deviceId]
    );
  },

};
