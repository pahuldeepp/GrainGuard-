import { Client } from 'cassandra-driver';

const CASSANDRA_HOSTS = (process.env.CASSANDRA_HOSTS || 'localhost').split(',');
const CASSANDRA_KEYSPACE = process.env.CASSANDRA_KEYSPACE || 'grainguard_telemetry';

let client: Client | null = null;

export async function getCassandraClient(): Promise<Client> {
  if (client) return client;

  client = new Client({
    contactPoints: CASSANDRA_HOSTS,
    localDataCenter: 'dc1',
    keyspace: CASSANDRA_KEYSPACE,
    socketOptions: { connectTimeout: 10000 },
  });

  try {
    await client.connect();
    console.log(`[cassandra] Connected to keyspace=${CASSANDRA_KEYSPACE}`);
  } catch (err) {
    console.error('[cassandra] Connection failed:', err);
    client = null;
    throw err;
  }

  return client;
}

export async function getTelemetryHistoryFromCassandra(
  tenantId: string,
  deviceId: string,
  limit = 50
): Promise<Array<{
  deviceId: string;
  temperature: number;
  humidity: number;
  recordedAt: string;
}>> {
  try {
    const cass = await getCassandraClient();
    const result = await cass.execute(
      `SELECT device_id, temperature, humidity, recorded_at
       FROM telemetry_readings
       WHERE tenant_id = ? AND device_id = ?
       LIMIT ?`,
      [tenantId, deviceId, limit],
      { prepare: true }
    );

    return result.rows.map((row) => ({
      deviceId:    row.device_id.toString(),
      temperature: row.temperature,
      humidity:    row.humidity,
      recordedAt:  row.recorded_at instanceof Date
        ? row.recorded_at.toISOString()
        : new Date(row.recorded_at).toISOString(),
    }));
  } catch (err) {
    console.error('[cassandra] getTelemetryHistory error:', err);
    // Fallback to empty — caller should fall back to Postgres
    throw err;
  }
}

export async function closeCassandraClient(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}

