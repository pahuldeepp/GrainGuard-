import os
import json
import time
import logging
import pika
from kafka import KafkaConsumer, KafkaProducer

logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","service":"risk-engine","msg":"%(message)s"}'
)
log = logging.getLogger(__name__)

# ── Config ──────────────────────────────────────────────────────────────────
KAFKA_BROKERS    = os.getenv("KAFKA_BROKERS", "kafka:9092").split(",")
IN_TOPIC         = os.getenv("TELEMETRY_TOPIC", "telemetry.events")
OUT_TOPIC        = os.getenv("RISK_SCORES_TOPIC", "risk.scores")
GROUP_ID         = os.getenv("KAFKA_GROUP_ID", "risk-engine")
RABBITMQ_URL     = os.getenv("RABBITMQ_URL", "amqp://grainguard:grainguard@rabbitmq:5672/grainguard")
ALERT_QUEUE      = "alerts"

# ── Thresholds ───────────────────────────────────────────────────────────────
# Score 0.0 (safe) → 1.0 (critical spoilage risk)
THRESHOLDS = {
    "temperature": {"warn": 30.0,  "critical": 35.0},  # Celsius
    "humidity":    {"warn": 70.0,  "critical": 80.0},  # %
}

def compute_risk_score(temperature: float | None, humidity: float | None) -> dict:
    """
    Weighted spoilage risk score.
    Temperature accounts for 60%, humidity 40%.
    Returns score 0.0–1.0 and level: safe | warn | critical
    """
    t_score = 0.0
    h_score = 0.0

    if temperature is not None:
        t_warn     = THRESHOLDS["temperature"]["warn"]
        t_critical = THRESHOLDS["temperature"]["critical"]
        if temperature >= t_critical:
            t_score = 1.0
        elif temperature >= t_warn:
            t_score = (temperature - t_warn) / (t_critical - t_warn)

    if humidity is not None:
        h_warn     = THRESHOLDS["humidity"]["warn"]
        h_critical = THRESHOLDS["humidity"]["critical"]
        if humidity >= h_critical:
            h_score = 1.0
        elif humidity >= h_warn:
            h_score = (humidity - h_warn) / (h_critical - h_warn)

    score = round((t_score * 0.6) + (h_score * 0.4), 4)

    if score >= 0.8:
        level = "critical"
    elif score >= 0.4:
        level = "warn"
    else:
        level = "safe"

    return {"score": score, "level": level, "t_score": t_score, "h_score": h_score}


def connect_rabbitmq(retries=10, delay=3):
    for attempt in range(1, retries + 1):
        try:
            params = pika.URLParameters(RABBITMQ_URL)
            conn   = pika.BlockingConnection(params)
            ch     = conn.channel()
            ch.queue_declare(queue=ALERT_QUEUE, durable=True)
            log.info("RabbitMQ connected")
            return conn, ch
        except Exception as e:
            log.warning(f"RabbitMQ attempt {attempt}/{retries} failed: {e}")
            time.sleep(delay)
    raise RuntimeError("Could not connect to RabbitMQ")


def connect_kafka_consumer(retries=10, delay=3):
    for attempt in range(1, retries + 1):
        try:
            consumer = KafkaConsumer(
                IN_TOPIC,
                bootstrap_servers=KAFKA_BROKERS,
                group_id=GROUP_ID,
                auto_offset_reset="latest",
                enable_auto_commit=True,
                value_deserializer=lambda m: json.loads(m.decode("utf-8")),
            )
            log.info(f"Kafka consumer connected topic={IN_TOPIC}")
            return consumer
        except Exception as e:
            log.warning(f"Kafka consumer attempt {attempt}/{retries} failed: {e}")
            time.sleep(delay)
    raise RuntimeError("Could not connect to Kafka consumer")


def connect_kafka_producer(retries=10, delay=3):
    for attempt in range(1, retries + 1):
        try:
            producer = KafkaProducer(
                bootstrap_servers=KAFKA_BROKERS,
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            )
            log.info(f"Kafka producer connected topic={OUT_TOPIC}")
            return producer
        except Exception as e:
            log.warning(f"Kafka producer attempt {attempt}/{retries} failed: {e}")
            time.sleep(delay)
    raise RuntimeError("Could not connect to Kafka producer")


def publish_alert(ch, device_id: str, tenant_id: str, score: float, level: str, temperature: float | None, humidity: float | None):
    job = {
        "deviceId":    device_id,
        "tenantId":    tenant_id,
        "score":       score,
        "level":       level,
        "temperature": temperature,
        "humidity":    humidity,
        "message":     f"Spoilage risk {level.upper()} — score {score:.2f} for device {device_id}",
        "recipients":  [f"alerts@tenant-{tenant_id}.grainguard.io"],
        "retryCount":  0,
    }
    ch.basic_publish(
        exchange="",
        routing_key=ALERT_QUEUE,
        body=json.dumps(job),
        properties=pika.BasicProperties(
            delivery_mode=2,  # persistent
            content_type="application/json",
        ),
    )
    log.info(f"Alert queued device={device_id} level={level} score={score}")


def main():
    log.info("Risk engine starting")

    consumer = connect_kafka_consumer()
    producer = connect_kafka_producer()
    rmq_conn, rmq_ch = connect_rabbitmq()

    log.info("Risk engine running — consuming telemetry events")

    for msg in consumer:
        try:
            event = msg.value

            # Extract fields from event envelope
            payload     = event.get("payload") or event
            device_id   = payload.get("device_id") or payload.get("deviceId")
            tenant_id   = payload.get("tenant_id") or payload.get("tenantId") or event.get("tenant_id")
            temperature = payload.get("temperature")
            humidity    = payload.get("humidity")

            if not device_id:
                continue

            # Convert to float safely
            try:
                temperature = float(temperature) if temperature is not None else None
                humidity    = float(humidity)    if humidity    is not None else None
            except (ValueError, TypeError):
                continue

            # Compute risk
            risk = compute_risk_score(temperature, humidity)

            # Publish risk score to Kafka
            risk_event = {
                "device_id":   device_id,
                "tenant_id":   tenant_id,
                "score":       risk["score"],
                "level":       risk["level"],
                "temperature": temperature,
                "humidity":    humidity,
            }
            producer.send(OUT_TOPIC, value=risk_event, key=device_id.encode() if device_id else None)

            # Fire alert if warn or critical
            if risk["level"] in ("warn", "critical"):
                try:
                    publish_alert(rmq_ch, device_id, tenant_id or "", risk["score"], risk["level"], temperature, humidity)
                except Exception as e:
                    log.error(f"RabbitMQ publish failed, reconnecting: {e}")
                    try:
                        rmq_conn, rmq_ch = connect_rabbitmq(retries=3, delay=1)
                        publish_alert(rmq_ch, device_id, tenant_id or "", risk["score"], risk["level"], temperature, humidity)
                    except Exception as e2:
                        log.error(f"RabbitMQ reconnect failed, alert dropped: {e2}")

            log.info(f"Scored device={device_id} score={risk['score']} level={risk['level']}")

        except Exception as e:
            log.error(f"Error processing message: {e}")
            continue


if __name__ == "__main__":
    main()
