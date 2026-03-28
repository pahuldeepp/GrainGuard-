import json
import logging
import os
import time
from typing import Any

import psycopg2
import psycopg2.extras
from kafka import KafkaConsumer, KafkaProducer

logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","service":"risk-engine","msg":"%(message)s"}',
)
log = logging.getLogger(__name__)

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092").split(",")
IN_TOPIC = os.getenv("TELEMETRY_TOPIC", "telemetry.events")
OUT_TOPIC = os.getenv("RISK_SCORES_TOPIC", "risk.scores")
GROUP_ID = os.getenv("KAFKA_GROUP_ID", "risk-engine")
DATABASE_URL = os.getenv("DATABASE_URL", "")

_rules_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
RULES_TTL = 60.0


def get_db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not configured")
    return psycopg2.connect(
        DATABASE_URL,
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


def fetch_alert_rules(tenant_id: str) -> list[dict[str, Any]]:
    now = time.monotonic()
    cached = _rules_cache.get(tenant_id)
    if cached and (now - cached[1]) < RULES_TTL:
        return cached[0]

    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT metric, operator, threshold, level
                       FROM alert_rules
                       WHERE tenant_id = %s AND enabled = TRUE""",
                    (tenant_id,),
                )
                rules = [dict(row) for row in cur.fetchall()]

        if not rules:
            rules = _default_rules()

        _rules_cache[tenant_id] = (rules, now)
        return rules
    except Exception as exc:
        log.warning("DB fetch failed for tenant=%s, using defaults: %s", tenant_id, exc)
        return _default_rules()


def _default_rules() -> list[dict[str, Any]]:
    return [
        {"metric": "temperature", "operator": ">=", "threshold": 30.0, "level": "warn"},
        {"metric": "temperature", "operator": ">=", "threshold": 35.0, "level": "critical"},
        {"metric": "humidity", "operator": ">=", "threshold": 70.0, "level": "warn"},
        {"metric": "humidity", "operator": ">=", "threshold": 80.0, "level": "critical"},
    ]


def fetch_alert_recipients(tenant_id: str) -> list[str]:
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT email FROM tenant_users
                       WHERE tenant_id = %s AND email IS NOT NULL""",
                    (tenant_id,),
                )
                rows = cur.fetchall()
        return [row["email"] for row in rows if row["email"]]
    except Exception as exc:
        log.warning("Could not fetch recipients for tenant=%s: %s", tenant_id, exc)
        return []


def _apply_operator(value: float, operator: str, threshold: float) -> bool:
    ops = {
        ">=": value >= threshold,
        ">": value > threshold,
        "<=": value <= threshold,
        "<": value < threshold,
        "==": value == threshold,
    }
    return ops.get(operator, False)


def compute_risk_score(
    temperature: float | None,
    humidity: float | None,
    rules: list[dict[str, Any]],
) -> dict[str, Any]:
    level_rank = {"safe": 0, "warn": 1, "critical": 2}
    triggered_level = "safe"

    t_score = 0.0
    h_score = 0.0
    t_threshold: float | None = None
    h_threshold: float | None = None

    t_rules = [rule for rule in rules if rule["metric"] == "temperature" and temperature is not None]
    h_rules = [rule for rule in rules if rule["metric"] == "humidity" and humidity is not None]

    for rule in t_rules:
        if _apply_operator(temperature, rule["operator"], float(rule["threshold"])):
            if level_rank.get(rule["level"], 0) > level_rank.get(triggered_level, 0):
                triggered_level = rule["level"]
            new_score = 1.0 if rule["level"] == "critical" else 0.5
            if new_score > t_score:
                t_score = new_score
                t_threshold = float(rule["threshold"])

    for rule in h_rules:
        if _apply_operator(humidity, rule["operator"], float(rule["threshold"])):
            if level_rank.get(rule["level"], 0) > level_rank.get(triggered_level, 0):
                triggered_level = rule["level"]
            new_score = 1.0 if rule["level"] == "critical" else 0.5
            if new_score > h_score:
                h_score = new_score
                h_threshold = float(rule["threshold"])

    score = round((t_score * 0.6) + (h_score * 0.4), 4)

    if triggered_level == "safe":
        if score >= 0.8:
            triggered_level = "critical"
        elif score >= 0.4:
            triggered_level = "warn"

    return {
        "score": score,
        "level": triggered_level,
        "t_score": t_score,
        "h_score": h_score,
        "t_threshold": t_threshold,
        "h_threshold": h_threshold,
    }


def connect_kafka_consumer(retries: int = 10, delay: int = 3) -> KafkaConsumer:
    for attempt in range(1, retries + 1):
        try:
            consumer = KafkaConsumer(
                IN_TOPIC,
                bootstrap_servers=KAFKA_BROKERS,
                group_id=GROUP_ID,
                auto_offset_reset="latest",
                enable_auto_commit=True,
                consumer_timeout_ms=1000,
            )
            log.info("Kafka consumer connected topic=%s", IN_TOPIC)
            return consumer
        except Exception as exc:
            log.warning("Kafka consumer attempt %s/%s failed: %s", attempt, retries, exc)
            time.sleep(delay)
    raise RuntimeError("Could not connect to Kafka consumer")


def connect_kafka_producer(retries: int = 10, delay: int = 3) -> KafkaProducer:
    for attempt in range(1, retries + 1):
        try:
            producer = KafkaProducer(
                bootstrap_servers=KAFKA_BROKERS,
                value_serializer=lambda value: json.dumps(value).encode("utf-8"),
            )
            log.info("Kafka producer connected topic=%s", OUT_TOPIC)
            return producer
        except Exception as exc:
            log.warning("Kafka producer attempt %s/%s failed: %s", attempt, retries, exc)
            time.sleep(delay)
    raise RuntimeError("Could not connect to Kafka producer")


def decode_json_message(raw: bytes) -> dict[str, Any] | None:
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return decoded if isinstance(decoded, dict) else None


def _coerce_number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def extract_telemetry_event(event: dict[str, Any]) -> dict[str, Any] | None:
    event_type = event.get("eventType") or event.get("event_type")
    if event_type and event_type != "telemetry.recorded":
        return None

    data = event.get("data")
    payload = event.get("payload")

    details = data if isinstance(data, dict) else payload if isinstance(payload, dict) else event

    device_id = (
        details.get("deviceId")
        or details.get("device_id")
        or event.get("aggregateId")
        or event.get("aggregate_id")
    )
    tenant_id = (
        details.get("tenantId")
        or details.get("tenant_id")
        or event.get("tenantId")
        or event.get("tenant_id")
    )

    if not device_id or not tenant_id:
        return None

    temperature = _coerce_number(details.get("temperature"))
    humidity = _coerce_number(details.get("humidity"))
    source_event_id = event.get("eventId") or event.get("event_id")
    occurred_at = event.get("occurredAt") or event.get("occurred_at")

    return {
        "device_id": str(device_id),
        "tenant_id": str(tenant_id),
        "temperature": temperature,
        "humidity": humidity,
        "source_event_id": str(source_event_id) if source_event_id else None,
        "occurred_at": str(occurred_at) if occurred_at else None,
    }


def main():
    log.info("Risk engine starting")

    consumer = connect_kafka_consumer()
    producer = connect_kafka_producer()

    log.info("Risk engine running — consuming telemetry events")

    while True:
        try:
            for msg in consumer:
                event = decode_json_message(msg.value)
                if event is None:
                    log.warning("Skipping non-JSON telemetry message on %s", IN_TOPIC)
                    continue

                telemetry = extract_telemetry_event(event)
                if telemetry is None:
                    continue

                temperature = telemetry["temperature"]
                humidity = telemetry["humidity"]
                tenant_id = telemetry["tenant_id"]
                device_id = telemetry["device_id"]

                rules = fetch_alert_rules(tenant_id)
                risk = compute_risk_score(temperature, humidity, rules)

                recipients: list[str] = []
                if risk["level"] in ("warn", "critical"):
                    recipients = fetch_alert_recipients(tenant_id)

                risk_event = {
                    "device_id": device_id,
                    "tenant_id": tenant_id,
                    "score": risk["score"],
                    "level": risk["level"],
                    "t_score": risk["t_score"],
                    "h_score": risk["h_score"],
                    "t_threshold": risk["t_threshold"],
                    "h_threshold": risk["h_threshold"],
                    "temperature": temperature,
                    "humidity": humidity,
                    "recipients": recipients,
                    "source_event_id": telemetry["source_event_id"],
                    "occurred_at": telemetry["occurred_at"],
                    "scored_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }

                future = producer.send(
                    OUT_TOPIC,
                    value=risk_event,
                    key=device_id.encode("utf-8"),
                )
                future.get(timeout=10)

                log.info(
                    "Scored device=%s score=%s level=%s recipients=%s",
                    device_id,
                    risk["score"],
                    risk["level"],
                    len(recipients),
                )
        except Exception as exc:
            log.error("Error processing message: %s", exc)
            time.sleep(1)


if __name__ == "__main__":
    main()
