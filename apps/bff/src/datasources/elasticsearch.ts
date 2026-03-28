import { Client } from "@elastic/elasticsearch";

const ES_URL = process.env.ELASTICSEARCH_URL || "http://elasticsearch:9200";

export const es = new Client({ node: ES_URL });

const DEVICE_INDEX = "grainguard-devices";

interface ESHit {
  _source: {
    device_id: string;
    tenant_id: string;
    serial_number: string;
    temperature?: number;
    humidity?: number;
    recorded_at?: string;
    status?: string;
  };
  _score: number;
}

export const search = {
  async searchDevices(query: string, tenantId: string, limit = 20) {
    try {
      const params = {
        index: DEVICE_INDEX,
        size: limit,
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query,
                  fields: ["serial_number", "device_id"],
                  fuzziness: "AUTO",
                },
              },
            ],
            filter: [
              {
                term: { tenant_id: tenantId },
              },
            ],
          },
        },
      };
      const result = await (es.search as (p: typeof params) => Promise<{ hits: { total: unknown; hits: ESHit[] } }>)(params);

      return result.hits.hits.map((hit: ESHit) => ({
        deviceId:     hit._source.device_id,
        tenantId:     hit._source.tenant_id,
        serialNumber: hit._source.serial_number,
        temperature:  hit._source.temperature ?? null,
        humidity:     hit._source.humidity ?? null,
        recordedAt:   hit._source.recorded_at ?? null,
        status:       hit._source.status ?? null,
        score:        hit._score,
      }));
    } catch (err: unknown) {
      const e = err as { meta?: { body?: { error?: unknown } }; message?: string };
      console.error("[ES] error:", e?.meta?.body?.error || e?.message || err);
      return [];
    }
  },
};
