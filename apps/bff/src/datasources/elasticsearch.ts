import { Client } from "@elastic/elasticsearch";

const ES_URL = process.env.ELASTICSEARCH_URL || "http://elasticsearch:9200";

export const es = new Client({ node: ES_URL });

const DEVICE_INDEX = "grainguard-devices";

interface DeviceDoc {
  device_id:     string;
  tenant_id:     string;
  serial_number: string;
  temperature?:  number;
  humidity?:     number;
  recorded_at?:  string;
  status?:       string;
}

export const search = {
  async searchDevices(query: string, tenantId: string, limit = 20) {
    try {
      const result = await es.search<DeviceDoc>({
        index: DEVICE_INDEX,
        size:  limit,
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query,
                  fields:    ["serial_number", "device_id"],
                  fuzziness: "AUTO",
                },
              },
            ],
            filter: [{ term: { tenant_id: tenantId } }],
          },
        },
      });

      return result.hits.hits.map((hit) => ({
        deviceId:     hit._source!.device_id,
        tenantId:     hit._source!.tenant_id,
        serialNumber: hit._source!.serial_number,
        temperature:  hit._source!.temperature  ?? null,
        humidity:     hit._source!.humidity     ?? null,
        recordedAt:   hit._source!.recorded_at  ?? null,
        status:       hit._source!.status       ?? null,
        score:        hit._score                ?? 0,
      }));
    } catch (err: unknown) {
      const e = err as { meta?: { body?: { error?: unknown } }; message?: string };
      console.error("[ES] error:", e?.meta?.body?.error || e?.message || err);
      return [];
    }
  },
};
