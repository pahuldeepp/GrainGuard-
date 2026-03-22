import json, logging, os, signal, time
from kafka import KafkaConsumer
from elasticsearch import Elasticsearch

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092").split(",")
ES_URL = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200")
TELEMETRY_TOPIC = os.getenv("TELEMETRY_TOPIC", "telemetry.events")
DEVICE_TOPIC = os.getenv("DEVICE_TOPIC", "device.events")
GROUP_ID = os.getenv("KAFKA_GROUP_ID", "search-indexer")
DEVICE_INDEX = "grainguard-devices"
TELEMETRY_INDEX = "grainguard-telemetry"

class SearchIndexer:
    def __init__(self):
        self.es = None
        self.consumer = None
        self.running = True
        signal.signal(signal.SIGTERM, self._shutdown)
        signal.signal(signal.SIGINT, self._shutdown)

    def _shutdown(self, s, f):
        self.running = False

    def connect_es(self):
        for i in range(10):
            try:
                self.es = Elasticsearch(ES_URL)
                self.es.info()
                log.info("Connected to Elasticsearch")
                return
            except Exception as e:
                log.warning(f"ES attempt {i+1}/10: {e}")
                time.sleep(5)
        raise RuntimeError("Could not connect to ES")

    def setup_indexes(self):
        for index, mapping in [
            (DEVICE_INDEX, {"mappings":{"properties":{"device_id":{"type":"keyword"},"tenant_id":{"type":"keyword"},"serial_number":{"type":"text"},"temperature":{"type":"float"},"humidity":{"type":"float"},"recorded_at":{"type":"date"},"status":{"type":"keyword"}}},"settings":{"number_of_shards":1,"number_of_replicas":0}}),
            (TELEMETRY_INDEX, {"mappings":{"properties":{"device_id":{"type":"keyword"},"tenant_id":{"type":"keyword"},"temperature":{"type":"float"},"humidity":{"type":"float"},"recorded_at":{"type":"date"}}},"settings":{"number_of_shards":1,"number_of_replicas":0}})
        ]:
            if not self.es.indices.exists(index=index):
                self.es.indices.create(index=index, body=mapping)
                log.info(f"Created index: {index}")

    def connect_kafka(self):
        for i in range(10):
            try:
                self.consumer = KafkaConsumer(
                    TELEMETRY_TOPIC, DEVICE_TOPIC,
                    bootstrap_servers=KAFKA_BROKERS,
                    group_id=GROUP_ID,
                    auto_offset_reset="earliest",
                    enable_auto_commit=False,
                    value_deserializer=lambda m: json.loads(m.decode("utf-8")),
                    consumer_timeout_ms=1000,
                )
                log.info("Connected to Kafka")
                return
            except Exception as e:
                log.warning(f"Kafka attempt {i+1}/10: {e}")
                time.sleep(5)
        raise RuntimeError("Could not connect to Kafka")

    def index_telemetry(self, event):
        try:
            payload = event.get("payload", {})
            device_id = event.get("aggregate_id") or payload.get("device_id")
            tenant_id = event.get("tenant_id")
            if not device_id or not tenant_id:
                return

            # Update current device state in device index
            self.es.update(
                index=DEVICE_INDEX,
                id=device_id,
                body={
                    "doc": {
                        "device_id": device_id,
                        "tenant_id": tenant_id,
                        "temperature": payload.get("temperature"),
                        "humidity": payload.get("humidity"),
                        "recorded_at": payload.get("recorded_at"),
                        "status": "active",
                    },
                    "doc_as_upsert": True,
                },
            )

            # Write time-series entry to telemetry index
            # Use composite key so concurrent writes don't create duplicates
            doc_id = f"{device_id}:{payload.get('recorded_at', '')}"
            self.es.update(
                index=TELEMETRY_INDEX,
                id=doc_id,
                body={
                    "doc": {
                        "device_id": device_id,
                        "tenant_id": tenant_id,
                        "temperature": payload.get("temperature"),
                        "humidity": payload.get("humidity"),
                        "recorded_at": payload.get("recorded_at"),
                    },
                    "doc_as_upsert": True,
                },
            )
        except Exception as e:
            log.error(f"Telemetry index error: {e}")

    def index_device(self, event):
        try:
            payload = event.get("payload", {})
            device_id = event.get("aggregate_id") or payload.get("device_id")
            tenant_id = event.get("tenant_id")
            if not device_id:
                return
            self.es.update(index=DEVICE_INDEX, id=device_id, body={"doc":{"device_id":device_id,"tenant_id":tenant_id,"serial_number":payload.get("serial_number"),"status":"registered"},"doc_as_upsert":True})
            log.info(f"Indexed device: {device_id}")
        except Exception as e:
            log.error(f"Device index error: {e}")

    def run(self):
        self.connect_es()
        self.setup_indexes()
        self.connect_kafka()
        log.info("Search indexer running")
        while self.running:
            try:
                for msg in self.consumer:
                    if not self.running:
                        break
                    if msg.topic == TELEMETRY_TOPIC:
                        self.index_telemetry(msg.value)
                    elif msg.topic == DEVICE_TOPIC:
                        self.index_device(msg.value)
                    self.consumer.commit()
            except StopIteration:
                pass
            except Exception as e:
                log.error(f"Error: {e}")
                time.sleep(1)
        if self.consumer:
            self.consumer.close()

if __name__ == "__main__":
    SearchIndexer().run()
