import { Pool } from "pg";

const pool = new Pool({
  host:     process.env.READ_DB_HOST     || "localhost",
  port:     parseInt(process.env.READ_DB_PORT || "5433"),
  database: process.env.READ_DB_NAME     || "grainguard_read",
  user:     process.env.READ_DB_USER     || "postgres",
  password: process.env.READ_DB_PASSWORD || "postgres",
  max: 10,
});

export const db = {

  async getDevice(deviceId: string) {
    const result = await pool.query(
      `SELECT device_id, tenant_id, serial_number, created_at
       FROM device_projections
       WHERE device_id = $1`,
      [deviceId]
    );
    return result.rows[0] || null;
  },

  async getAllDevices(limit: number = 20) {
    const result = await pool.query(
      `SELECT device_id, tenant_id, serial_number, created_at
       FROM device_projections
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  async getDeviceTelemetry(deviceId: string) {
    const result = await pool.query(
      `SELECT device_id, temperature, humidity, recorded_at, updated_at, version
       FROM device_telemetry_latest
       WHERE device_id = $1`,
      [deviceId]
    );
    return result.rows[0] || null;
  },

  async getAllTelemetry(limit: number = 20, tenantId?: string) {
    if (tenantId) {
      const result = await pool.query(
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
    const result = await pool.query(
      `SELECT device_id, temperature, humidity, recorded_at, updated_at, version
       FROM device_telemetry_latest
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  async getDeviceWithTelemetry(deviceId: string) {
    const result = await pool.query(
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
    const result = await pool.query(
      `SELECT device_id, temperature, humidity, recorded_at
       FROM device_telemetry_history
       WHERE device_id = $1
       ORDER BY recorded_at ASC
       LIMIT $2`,
      [deviceId, limit]
    );
    return result.rows.map((r) => ({
      deviceId:    r.device_id,
      temperature: r.temperature,
      humidity:    r.humidity,
      recordedAt:  r.recorded_at,
    }));
  },

  async getAllDevicesWithTelemetry(limit: number = 20, tenantId?: string) {
    if (tenantId) {
      const result = await pool.query(
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
    const result = await pool.query(
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
};
