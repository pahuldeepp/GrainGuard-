// review-sweep
import { Client } from "@elastic/elasticsearch";

const ES_URL = process.env.ELASTICSEARCH_URL || "http://elasticsearch:9200";

export const es = new Client({ node: ES_URL });

const DEVICE_INDEX = "grainguard-devices";

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
      console.log("[ES] searching:", JSON.stringify(params));
      const result = await (es.search as any)(params);
      console.log("[ES] hits:", result.hits.total);

      return result.hits.hits.map((hit: any) => ({
        deviceId:     hit._source.device_id,
        tenantId:     hit._source.tenant_id,
        serialNumber: hit._source.serial_number,
        temperature:  hit._source.temperature ?? null,
        humidity:     hit._source.humidity ?? null,
        recordedAt:   hit._source.recorded_at ?? null,
        status:       hit._source.status ?? null,
        score:        hit._score,
      }));
    } catch (err: any) {
      console.error("[ES] error:", err?.meta?.body?.error || err?.message || err);
      return [];
    }
  },
};
