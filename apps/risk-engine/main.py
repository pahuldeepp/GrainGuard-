import os
import json
import time
import logging
import psycopg2
import psycopg2.extras
from kafka import KafkaConsumer, KafkaProducer

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
DATABASE_URL  = os.getenv("DATABASE_URL")

# Rule cache: tenant_id → (rules, fetched_at)
_rules_cache: dict[str, tuple[list, float]] = {}
RULES_TTL = 60.0  # seconds


# ── Postgres ─────────────────────────────────────────────────────────────────
def get_db():
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)


def fetch_alert_rules(tenant_id: str) -> list[dict]:
    """
    Fetch enabled alert rules for the tenant from Postgres.
    Cached for RULES_TTL seconds. Falls back to built-in defaults.
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
    Fetch emails of tenant users who should receive alerts.
    Included in the Kafka event so workflow-alerts doesn't need a DB call.
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
    Returns score, level, t_score, h_score, and triggered thresholds per metric.
    """
    level_rank = {"safe": 0, "warn": 1, "critical": 2}
    triggered_level = "safe"

    t_score = 0.0
    h_score = 0.0
    t_threshold: float | None = None
    h_threshold: float | None = None

    t_rules = [r for r in rules if r["metric"] == "temperature" and temperature is not None]
    h_rules = [r for r in rules if r["metric"] == "humidity"    and humidity    is not None]

    for rule in t_rules:
        if _apply_operator(temperature, rule["operator"], rule["threshold"]):
            if level_rank.get(rule["level"], 0) > level_rank.get(triggered_level, 0):
                triggered_level = rule["level"]
            new_score = 1.0 if rule["level"] == "critical" else 0.5
            if new_score > t_score:
                t_score = new_score
                t_threshold = rule["threshold"]

    for rule in h_rules:
        if _apply_operator(humidity, rule["operator"], rule["threshold"]):
            if level_rank.get(rule["level"], 0) > level_rank.get(triggered_level, 0):
                triggered_level = rule["level"]
            new_score = 1.0 if rule["level"] == "critical" else 0.5
            if new_score > h_score:
                h_score = new_score
                h_threshold = rule["threshold"]

    score = round((t_score * 0.6) + (h_score * 0.4), 4)

    if triggered_level == "safe":
        if score >= 0.8:
            triggered_level = "critical"
        elif score >= 0.4:
            triggered_level = "warn"

    return {
        "score":       score,
        "level":       triggered_level,
        "t_score":     t_score,
        "h_score":     h_score,
        "t_threshold": t_threshold,
        "h_threshold": h_threshold,
    }


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


# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    log.info("Risk engine starting")

    consumer = connect_kafka_consumer()
    producer = connect_kafka_producer()

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

            rules = fetch_alert_rules(tenant_id) if tenant_id else _default_rules()
            risk  = compute_risk_score(temperature, humidity, rules)

            # Fetch recipients only when alert will fire — avoids DB hit on every event
            recipients: list[str] = []
            if risk["level"] in ("warn", "critical") and tenant_id:
                recipients = fetch_alert_recipients(tenant_id)

            # Publish full risk event to Kafka — workflow-alerts consumes this
            risk_event = {
                "device_id":   device_id,
                "tenant_id":   tenant_id,
                "score":       risk["score"],
                "level":       risk["level"],
                "t_score":     risk["t_score"],
                "h_score":     risk["h_score"],
                "t_threshold": risk["t_threshold"],
                "h_threshold": risk["h_threshold"],
                "temperature": temperature,
                "humidity":    humidity,
                "recipients":  recipients,
            }
            producer.send(OUT_TOPIC, value=risk_event, key=device_id.encode() if device_id else None)

            log.info(f"Scored device={device_id} score={risk['score']} level={risk['level']} recipients={len(recipients)}")

        except Exception as e:
            log.error(f"Error processing message: {e}")
            continue


if __name__ == "__main__":
    main()
