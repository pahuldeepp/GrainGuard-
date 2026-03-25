import os
import json
import time
import logging
import psycopg2
import psycopg2.extras
import pika
from kafka import KafkaConsumer, KafkaProducer
from functools import lru_cache

logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","service":"risk-engine","msg":"%(message)s"}'
)
log = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092").split(",")
IN_TOPIC      = os.getenv("TELEMETRY_TOPIC", "telemetry.events")
OUT_TOPIC     = os.getenv("RISK_SCORES_TOPIC", "risk.scores")
GROUP_ID      = os.getenv("KAFKA_GROUP_ID", "risk-engine")
RABBITMQ_URL  = os.getenv("RABBITMQ_URL", "amqp://grainguard:grainguard@rabbitmq:5672/grainguard")
DATABASE_URL  = os.getenv("DATABASE_URL")
ALERT_QUEUE   = "alerts"

# Rule cache: tenant_id → (rules, fetched_at)
_rules_cache: dict[str, tuple[list, float]] = {}
RULES_TTL = 60.0  # seconds


# ── Postgres ─────────────────────────────────────────────────────────────────
def get_db():
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)


def fetch_alert_rules(tenant_id: str) -> list[dict]:
    """
    Fetch enabled alert rules for the tenant from Postgres.
    Returns list of dicts: {metric, operator, threshold, level}
    Falls back to safe built-in defaults if DB is unavailable.
    """
    now = time.monotonic()
    cached = _rules_cache.get(tenant_id)
    if cached and (now - cached[1]) < RULES_TTL:
        return cached[0]

    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """SELECT metric, operator, threshold, level
                   FROM alert_rules
                   WHERE tenant_id = %s AND enabled = TRUE""",
                (tenant_id,),
            )
            rules = [dict(r) for r in cur.fetchall()]
        conn.close()

        # If tenant has no rules configured, fall back to sensible defaults
        if not rules:
            rules = _default_rules()

        _rules_cache[tenant_id] = (rules, now)
        return rules
    except Exception as e:
        log.warning(f"DB fetch failed for tenant={tenant_id}, using defaults: {e}")
        return _default_rules()


def _default_rules() -> list[dict]:
    return [
        {"metric": "temperature", "operator": ">=", "threshold": 30.0, "level": "warn"},
        {"metric": "temperature", "operator": ">=", "threshold": 35.0, "level": "critical"},
        {"metric": "humidity",    "operator": ">=", "threshold": 70.0, "level": "warn"},
        {"metric": "humidity",    "operator": ">=", "threshold": 80.0, "level": "critical"},
    ]


def fetch_alert_recipients(tenant_id: str) -> list[str]:
    """
    Fetch real email addresses of tenant admins/members who should receive alerts.
    Falls back to empty list (alert still queued, jobs-worker can handle fallback).
    """
    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """SELECT email FROM tenant_users
                   WHERE tenant_id = %s AND email IS NOT NULL""",
                (tenant_id,),
            )
            rows = cur.fetchall()
        conn.close()
        return [r["email"] for r in rows if r["email"]]
    except Exception as e:
        log.warning(f"Could not fetch recipients for tenant={tenant_id}: {e}")
        return []


# ── Risk scoring ─────────────────────────────────────────────────────────────
def _apply_operator(value: float, operator: str, threshold: float) -> bool:
    ops = {
        ">=": value >= threshold,
        ">":  value > threshold,
        "<=": value <= threshold,
        "<":  value < threshold,
        "==": value == threshold,
    }
    return ops.get(operator, False)


def compute_risk_score(
    temperature: float | None,
    humidity: float | None,
    rules: list[dict],
) -> dict:
    """
    Evaluate tenant alert rules to produce a risk score 0.0–1.0.
    Temperature weight: 60%, humidity weight: 40%.
    Level is the highest severity triggered across all rules.
    """
    level_rank = {"safe": 0, "warn": 1, "critical": 2}
    triggered_level = "safe"

    t_score = 0.0
    h_score = 0.0

    # Collect per-metric thresholds to normalise partial scores
    t_rules = [r for r in rules if r["metric"] == "temperature" and temperature is not None]
    h_rules = [r for r in rules if r["metric"] == "humidity"    and humidity    is not None]

    for rule in t_rules:
        if _apply_operator(temperature, rule["operator"], rule["threshold"]):
            if level_rank.get(rule["level"], 0) > level_rank.get(triggered_level, 0):
                triggered_level = rule["level"]
            # Normalise: critical = 1.0, warn = 0.5
            t_score = max(t_score, 1.0 if rule["level"] == "critical" else 0.5)

    for rule in h_rules:
        if _apply_operator(humidity, rule["operator"], rule["threshold"]):
            if level_rank.get(rule["level"], 0) > level_rank.get(triggered_level, 0):
                triggered_level = rule["level"]
            h_score = max(h_score, 1.0 if rule["level"] == "critical" else 0.5)

    score = round((t_score * 0.6) + (h_score * 0.4), 4)

    # Re-derive level from score if no rule triggered (belt-and-suspenders)
    if triggered_level == "safe":
        if score >= 0.8:
            triggered_level = "critical"
        elif score >= 0.4:
            triggered_level = "warn"

    return {"score": score, "level": triggered_level, "t_score": t_score, "h_score": h_score}


# ── RabbitMQ ──────────────────────────────────────────────────────────────────
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


# ── Kafka ─────────────────────────────────────────────────────────────────────
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


def publish_alert(
    ch,
    device_id: str,
    tenant_id: str,
    score: float,
    level: str,
    temperature: float | None,
    humidity: float | None,
    recipients: list[str],
):
    job = {
        "deviceId":    device_id,
        "tenantId":    tenant_id,
        "score":       score,
        "level":       level,
        "temperature": temperature,
        "humidity":    humidity,
        "message":     f"Spoilage risk {level.upper()} — score {score:.2f} for device {device_id}",
        "recipients":  recipients,   # real emails from DB
        "retryCount":  0,
    }
    ch.basic_publish(
        exchange="",
        routing_key=ALERT_QUEUE,
        body=json.dumps(job),
        properties=pika.BasicProperties(
            delivery_mode=2,
            content_type="application/json",
        ),
    )
    log.info(f"Alert queued device={device_id} level={level} score={score} recipients={len(recipients)}")


# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    log.info("Risk engine starting")

    consumer = connect_kafka_consumer()
    producer = connect_kafka_producer()
    rmq_conn, rmq_ch = connect_rabbitmq()

    log.info("Risk engine running — consuming telemetry events")

    for msg in consumer:
        try:
            event = msg.value

            payload     = event.get("payload") or event
            device_id   = payload.get("device_id") or payload.get("deviceId")
            tenant_id   = payload.get("tenant_id") or payload.get("tenantId") or event.get("tenant_id")
            temperature = payload.get("temperature")
            humidity    = payload.get("humidity")

            if not device_id:
                continue

            try:
                temperature = float(temperature) if temperature is not None else None
                humidity    = float(humidity)    if humidity    is not None else None
            except (ValueError, TypeError):
                continue

            # Load per-tenant rules from DB (cached 60 s)
            rules = fetch_alert_rules(tenant_id) if tenant_id else _default_rules()

            risk = compute_risk_score(temperature, humidity, rules)

            risk_event = {
                "device_id":   device_id,
                "tenant_id":   tenant_id,
                "score":       risk["score"],
                "level":       risk["level"],
                "temperature": temperature,
                "humidity":    humidity,
            }
            producer.send(OUT_TOPIC, value=risk_event, key=device_id.encode() if device_id else None)

            if risk["level"] in ("warn", "critical"):
                recipients = fetch_alert_recipients(tenant_id) if tenant_id else []
                try:
                    publish_alert(rmq_ch, device_id, tenant_id or "", risk["score"], risk["level"], temperature, humidity, recipients)
                except Exception as e:
                    log.error(f"RabbitMQ publish failed, reconnecting: {e}")
                    try:
                        rmq_conn, rmq_ch = connect_rabbitmq(retries=3, delay=1)
                        publish_alert(rmq_ch, device_id, tenant_id or "", risk["score"], risk["level"], temperature, humidity, recipients)
                    except Exception as e2:
                        log.error(f"RabbitMQ reconnect failed, alert dropped: {e2}")

            log.info(f"Scored device={device_id} score={risk['score']} level={risk['level']}")

        except Exception as e:
            log.error(f"Error processing message: {e}")
            continue


if __name__ == "__main__":
    main()