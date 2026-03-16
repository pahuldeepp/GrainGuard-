import { Client } from "pg";
import { pubsub, TELEMETRY_UPDATED, TENANT_TELEMETRY_UPDATED } from "./pubsub";

const WRITE_DB_URL = process.env.WRITE_DB_URL ||
  "postgres://postgres:postgres@localhost:5433/grainguard_read";

export async function startTelemetryWatcher() {
  const client = new Client({ connectionString: WRITE_DB_URL });

  await client.connect();

  await client.query(`
    CREATE OR REPLACE FUNCTION notify_telemetry_update()
    RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify(
        'telemetry_updated',
        json_build_object(
          'device_id',   NEW.device_id,
          'tenant_id',   NEW.tenant_id,
          'temperature', NEW.temperature,
          'humidity',    NEW.humidity,
          'recorded_at', NEW.recorded_at,
          'updated_at',  NEW.updated_at,
          'version',     NEW.version
        )::text
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await client.query(`
    DROP TRIGGER IF EXISTS telemetry_update_trigger
      ON device_telemetry_latest;

    CREATE TRIGGER telemetry_update_trigger
    AFTER INSERT OR UPDATE ON device_telemetry_latest
    FOR EACH ROW EXECUTE FUNCTION notify_telemetry_update();
  `);

  await client.query("LISTEN telemetry_updated");

  client.on("notification", (msg) => {
    if (!msg.payload) return;

    try {
      const data = JSON.parse(msg.payload);

      const telemetry = {
        deviceId:    data.device_id,
        temperature: data.temperature,
        humidity:    data.humidity,
        recordedAt:  data.recorded_at,
        updatedAt:   data.updated_at,
        version:     data.version,
      };

      // Publish to device-specific subscribers
      pubsub.publish(
        `${TELEMETRY_UPDATED}:${data.tenant_id}:${data.device_id}`,
        telemetry
      );

      // Publish to tenant-wide subscribers
      pubsub.publish(
        `${TENANT_TELEMETRY_UPDATED}:${data.tenant_id}`,
        telemetry
      );

    } catch (err) {
      console.error("[telemetry-watcher] Failed to parse notification:", err);
    }
  });

  client.on("error", (err) => {
    console.error("[telemetry-watcher] Postgres error:", err);
  });

  console.log(JSON.stringify({
    level: "info",
    service: "bff",
    message: "Telemetry watcher started — listening for Postgres NOTIFY",
  }));
}
