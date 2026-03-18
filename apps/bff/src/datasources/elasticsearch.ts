import { Client } from "@elastic/elasticsearch";

const ES_URL = process.env.ELASTICSEARCH_URL || "http://elasticsearch:9200";

export const es = new Client({ node: ES_URL });

const DEVICE_INDEX = "grainguard-devices";

export const search = {
  async searchDevices(query: string, tenantId: string, limit = 20) {
    try {
      const result = await es.search({
        index: DEVICE_INDEX,
        body: {
          size: limit,
          query: {
            bool: {
              must: [
                {
                  multi_match: {
                    query,
                    fields: ["serial_number^3", "serial_number.keyword", "device_id"],
                    fuzziness: "AUTO",
                  },
                },
              ],
              filter: [
                { term: { tenant_id: tenantId } },
              ],
            },
          },
        },
      });

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
    } catch (err) {
      console.error("[elasticsearch] searchDevices error:", err);
      return [];
    }
  },
};
