package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
)

type OutboxWorker struct {
	pool    *pgxpool.Pool
	writers map[string]*kafka.Writer
}

type legacyDeviceCreatedPayload struct {
	DeviceID  string `json:"device_id"`
	TenantID  string `json:"tenant_id"`
	Serial    string `json:"serial"`
	CreatedAt string `json:"created_at"`
}

type legacyTelemetryPayload struct {
	ID          string  `json:"id"`
	DeviceID    string  `json:"device_id"`
	DeviceIDAlt string  `json:"deviceId"`
	TenantID    string  `json:"tenant_id"`
	TenantIDAlt string  `json:"tenantId"`
	Temperature float64 `json:"temperature"`
	Humidity    float64 `json:"humidity"`
	RecordedAt  string  `json:"recorded_at"`
	RecordedAlt string  `json:"recordedAt"`
}

type legacyTelemetryEnvelope struct {
	EventID        string                 `json:"event_id"`
	EventIDAlt     string                 `json:"eventId"`
	EventType      string                 `json:"event_type"`
	EventTypeAlt   string                 `json:"eventType"`
	AggregateID    string                 `json:"aggregate_id"`
	AggregateIDAlt string                 `json:"aggregateId"`
	TenantID       string                 `json:"tenant_id"`
	TenantIDAlt    string                 `json:"tenantId"`
	OccurredAt     string                 `json:"occurred_at"`
	OccurredAtAlt  string                 `json:"occurredAt"`
	Data           legacyTelemetryPayload `json:"data"`
	Payload        legacyTelemetryPayload `json:"payload"`
}

type kafkaTelemetryEvent struct {
	EventID     string         `json:"eventId"`
	EventType   string         `json:"eventType"`
	AggregateID string         `json:"aggregateId"`
	OccurredAt  string         `json:"occurredAt"`
	Data        map[string]any `json:"data"`
}

type kafkaDeviceEvent struct {
	EventID          string         `json:"event_id"`
	EventType        string         `json:"event_type"`
	AggregateID      string         `json:"aggregate_id"`
	TenantID         string         `json:"tenant_id"`
	OccurredAtUnixMs int64          `json:"occurred_at_unix_ms"`
	Payload          map[string]any `json:"payload"`
}

func NewOutboxWorker(pool *pgxpool.Pool) *OutboxWorker {
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "kafka:9092"
	}

	brokerList := strings.Split(brokers, ",")

	newWriter := func(topic string) *kafka.Writer {
		return &kafka.Writer{
			Addr:     kafka.TCP(brokerList...),
			Topic:    topic,
			Balancer: &kafka.LeastBytes{},
		}
	}

	return &OutboxWorker{
		pool: pool,
		writers: map[string]*kafka.Writer{
			"telemetry.recorded": newWriter("telemetry.events"),
			"device_created_v1":  newWriter("device.events"),
		},
	}
}

func (w *OutboxWorker) writerForEvent(eventType string) *kafka.Writer {
	if writer, ok := w.writers[eventType]; ok {
		return writer
	}
	return w.writers["telemetry.recorded"]
}

func decodeEnvelope(eventID string, eventType string, payload []byte) (*eventspb.EventEnvelope, error) {
	var env eventspb.EventEnvelope
	if err := proto.Unmarshal(payload, &env); err == nil {
		return &env, nil
	}

	if eventType == "telemetry.recorded" {
		var legacy legacyTelemetryEnvelope
		if err := json.Unmarshal(payload, &legacy); err != nil {
			return nil, err
		}

		data := legacy.Data
		if data == (legacyTelemetryPayload{}) {
			data = legacy.Payload
		}

		aggregateID := firstNonEmpty(legacy.AggregateIDAlt, legacy.AggregateID, data.DeviceIDAlt, data.DeviceID)
		tenantID := firstNonEmpty(data.TenantIDAlt, data.TenantID, legacy.TenantIDAlt, legacy.TenantID)
		recordedAt := firstNonEmpty(data.RecordedAlt, data.RecordedAt)
		occurredAt := firstNonEmpty(legacy.OccurredAtAlt, legacy.OccurredAt, recordedAt)

		occurredAtUnixMs := time.Now().UTC().UnixMilli()
		if occurredAt != "" {
			if parsed, err := time.Parse(time.RFC3339Nano, occurredAt); err == nil {
				occurredAtUnixMs = parsed.UTC().UnixMilli()
			} else if parsed, err := time.Parse(time.RFC3339, occurredAt); err == nil {
				occurredAtUnixMs = parsed.UTC().UnixMilli()
			}
		}

		return &eventspb.EventEnvelope{
			EventId:          firstNonEmpty(legacy.EventIDAlt, legacy.EventID, eventID),
			EventType:        "telemetry.recorded",
			SchemaVersion:    1,
			OccurredAtUnixMs: occurredAtUnixMs,
			TenantId:         tenantID,
			AggregateId:      aggregateID,
			Payload: &eventspb.EventEnvelope_TelemetryRecordedV1{
				TelemetryRecordedV1: &eventspb.TelemetryRecordedV1{
					Id:          data.ID,
					DeviceId:    firstNonEmpty(data.DeviceIDAlt, data.DeviceID, aggregateID),
					Temperature: data.Temperature,
					Humidity:    data.Humidity,
					RecordedAt:  recordedAt,
				},
			},
		}, nil
	}

	if eventType == "device_created_v1" {
		var legacy legacyDeviceCreatedPayload
		if err := json.Unmarshal(payload, &legacy); err != nil {
			return nil, err
		}

		return &eventspb.EventEnvelope{
			EventId:          eventID,
			EventType:        "device_created_v1",
			SchemaVersion:    1,
			OccurredAtUnixMs: time.Now().UTC().UnixMilli(),
			TenantId:         legacy.TenantID,
			AggregateId:      legacy.DeviceID,
			Payload: &eventspb.EventEnvelope_DeviceCreatedV1{
				DeviceCreatedV1: &eventspb.DeviceCreatedV1{
					DeviceId:  legacy.DeviceID,
					TenantId:  legacy.TenantID,
					Serial:    legacy.Serial,
					CreatedAt: legacy.CreatedAt,
				},
			},
		}, nil
	}

	return nil, fmt.Errorf("unsupported outbox event type %q", eventType)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func occurredAtRFC3339(unixMs int64) string {
	if unixMs <= 0 {
		return time.Now().UTC().Format(time.RFC3339Nano)
	}
	return time.UnixMilli(unixMs).UTC().Format(time.RFC3339Nano)
}

func marshalForKafka(eventType string, env *eventspb.EventEnvelope) ([]byte, error) {
	switch eventType {
	case "telemetry.recorded":
		telemetry := env.GetTelemetryRecordedV1()
		if telemetry == nil {
			return nil, fmt.Errorf("missing telemetry payload for event %s", env.GetEventId())
		}

		return json.Marshal(kafkaTelemetryEvent{
			EventID:     env.GetEventId(),
			EventType:   env.GetEventType(),
			AggregateID: env.GetAggregateId(),
			OccurredAt:  occurredAtRFC3339(env.GetOccurredAtUnixMs()),
			Data: map[string]any{
				"id":          telemetry.GetId(),
				"deviceId":    telemetry.GetDeviceId(),
				"tenantId":    env.GetTenantId(),
				"temperature": telemetry.GetTemperature(),
				"humidity":    telemetry.GetHumidity(),
				"recordedAt":  telemetry.GetRecordedAt(),
			},
		})

	case "device_created_v1":
		device := env.GetDeviceCreatedV1()
		if device == nil {
			return nil, fmt.Errorf("missing device payload for event %s", env.GetEventId())
		}

		return json.Marshal(kafkaDeviceEvent{
			EventID:          env.GetEventId(),
			EventType:        env.GetEventType(),
			AggregateID:      env.GetAggregateId(),
			TenantID:         env.GetTenantId(),
			OccurredAtUnixMs: env.GetOccurredAtUnixMs(),
			Payload: map[string]any{
				"device_id":     device.GetDeviceId(),
				"tenant_id":     device.GetTenantId(),
				"serial":        device.GetSerial(),
				"serial_number": device.GetSerial(),
				"created_at":    device.GetCreatedAt(),
			},
		})
	default:
		return nil, fmt.Errorf("unsupported outbox event type %q", eventType)
	}
}

func (w *OutboxWorker) Start(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			w.processBatch(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (w *OutboxWorker) processBatch(ctx context.Context) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		log.Println("tx begin error:", err)
		return
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT id, event_type, payload::text
		FROM outbox_events
		WHERE published_at IS NULL
		ORDER BY created_at
		FOR UPDATE SKIP LOCKED
		LIMIT 10`)
	if err != nil {
		log.Println("query error:", err)
		return
	}
	defer rows.Close()

	type event struct {
		id        string
		eventType string
		payload   []byte
	}

	var events []event

	for rows.Next() {
		var id, eventType string
		var payload []byte

		if err := rows.Scan(&id, &eventType, &payload); err != nil {
			log.Println("scan error:", err)
			continue
		}

		events = append(events, event{
			id:        id,
			eventType: eventType,
			payload:   payload,
		})
	}

	if err := rows.Err(); err != nil {
		log.Println("rows iteration error:", err)
		return
	}

	if len(events) == 0 {
		return
	}

	for _, e := range events {
		env, err := decodeEnvelope(e.id, e.eventType, e.payload)
		if err != nil {
			log.Println("protobuf unmarshal error:", err)
			continue
		}

		marshaledPayload, err := marshalForKafka(e.eventType, env)
		if err != nil {
			log.Println("kafka payload normalize error:", err)
			continue
		}

		key := []byte(env.AggregateId)

		headers := []kafka.Header{
			{Key: "event_type", Value: []byte(e.eventType)},
			{Key: "schema_version", Value: []byte("1")},
		}

		err = w.writerForEvent(e.eventType).WriteMessages(ctx,
			kafka.Message{
				Key:     key,
				Value:   marshaledPayload,
				Headers: headers,
			},
		)
		if err != nil {
			log.Println("kafka publish error:", err)
			return
		}

		_, err = tx.Exec(ctx,
			`UPDATE outbox_events
			 SET published_at = NOW()
			 WHERE id = $1`,
			e.id)
		if err != nil {
			log.Println("update error:", err)
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		log.Println("commit error:", err)
	}
}
