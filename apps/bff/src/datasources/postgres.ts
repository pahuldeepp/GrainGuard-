import { Pool } from "pg";
import { postgresCircuitBreaker } from "../lib/circuitBreaker";

const pool = new Pool({
  host:     process.env.READ_DB_HOST     || "postgres-read",
  port:     parseInt(process.env.READ_DB_PORT || "5432"),
  database: process.env.READ_DB_NAME     || "grainguard_read",
  user:     process.env.READ_DB_USER     || "postgres",
  password: process.env.READ_DB_PASSWORD || "postgres",
  max: 10,
});


// Circuit-breaker-wrapped query helper
async function cbQuery(text: string, values?: any[]): Promise<import("pg").QueryResult<any>> {
  return postgresCircuitBreaker.execute(() => pool.query(text, values));
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
    const result = await cbQuery(
      `SELECT device_id, tenant_id, serial_number, created_at
       FROM device_projections
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
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
      return result.rows;
    }
    const result = await cbQuery(
      `SELECT device_id, temperature, humidity, recorded_at, updated_at, version
       FROM device_telemetry_latest
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
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

  async getTelemetryHistory(deviceId: string, limit = 50) {
    const result = await cbQuery(
      `SELECT device_id, temperature, humidity, recorded_at
       FROM device_telemetry_history
       WHERE device_id = $1
       ORDER BY recorded_at ASC
       LIMIT $2`,
      [deviceId, limit]
    );
    return result.rows.map((r: any) => ({
      deviceId:    r.device_id,
      temperature: r.temperature,
      humidity:    r.humidity,
      recordedAt:  r.recorded_at,
    }));
  },

  async getAllDevicesWithTelemetry(limit: number = 20, tenantId?: string) {
    if (tenantId) {
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
         WHERE d.tenant_id = $1
         ORDER BY d.created_at DESC
         LIMIT $2`,
        [tenantId, limit]
      );
      return result.rows;
    }
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
       ORDER BY d.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
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
    let rows: any[];

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
      totalCount = parseInt(countResult.rows[0].count, 10);
    } else {
      const countResult = await cbQuery("SELECT COUNT(*) FROM device_projections");
      totalCount = parseInt(countResult.rows[0].count, 10);
    }

    const edges = items.map((row: any) => ({
      cursor: Buffer.from(row.created_at.toISOString()).toString("base64"),
      node: {
        deviceId:     row.device_id,
        tenantId:     row.tenant_id,
        serialNumber: row.serial_number,
        createdAt:    new Date(row.created_at).toISOString(),
        temperature:  row.temperature ?? null,
        humidity:     row.humidity ?? null,
        recordedAt:   row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
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
};
