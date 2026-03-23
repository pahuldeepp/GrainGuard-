package worker

import (
	"context"
	"encoding/json"
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
	pool   *pgxpool.Pool
	writer *kafka.Writer
}

func NewOutboxWorker(pool *pgxpool.Pool) *OutboxWorker {
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "kafka:9092"
	}

	brokerList := strings.Split(brokers, ",")

	writer := &kafka.Writer{
		Addr:     kafka.TCP(brokerList...),
		Topic:    "device.events",
		Balancer: &kafka.LeastBytes{},
	}

	return &OutboxWorker{
		pool:   pool,
		writer: writer,
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
		SELECT id, event_type, payload
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
		var id string
		var eventType string
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
		protoBytes, err := buildEnvelope(e.id, e.eventType, e.payload)
		if err != nil {
			log.Printf("build envelope error (id=%s type=%s): %v", e.id, e.eventType, err)
			continue
		}
		if protoBytes == nil {
			// unknown event type — mark published to avoid reprocessing
			_, _ = tx.Exec(ctx, `UPDATE outbox_events SET published_at = NOW() WHERE id = $1`, e.id)
			continue
		}

		err = w.writer.WriteMessages(ctx,
			kafka.Message{
				Key:   []byte(e.id),
				Value: protoBytes,
				Headers: []kafka.Header{
					{Key: "event_type", Value: []byte(e.eventType)},
					{Key: "schema_version", Value: []byte("1")},
				},
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

// buildEnvelope converts a JSON outbox payload into a serialized protobuf EventEnvelope.
// Returns nil bytes (no error) for unknown event types.
func buildEnvelope(eventID, eventType string, jsonPayload []byte) ([]byte, error) {
	switch eventType {
	case "device_created_v1":
		var p struct {
			DeviceID  string `json:"device_id"`
			TenantID  string `json:"tenant_id"`
			Serial    string `json:"serial"`
			CreatedAt string `json:"created_at"`
		}
		if err := json.Unmarshal(jsonPayload, &p); err != nil {
			return nil, err
		}

		env := &eventspb.EventEnvelope{
			EventId:          eventID,
			EventType:        eventType,
			SchemaVersion:    1,
			OccurredAtUnixMs: time.Now().UnixMilli(),
			TenantId:         p.TenantID,
			AggregateId:      p.DeviceID,
			Payload: &eventspb.EventEnvelope_DeviceCreatedV1{
				DeviceCreatedV1: &eventspb.DeviceCreatedV1{
					DeviceId:  p.DeviceID,
					TenantId:  p.TenantID,
					Serial:    p.Serial,
					CreatedAt: p.CreatedAt,
				},
			},
		}
		return proto.Marshal(env)

	default:
		return nil, nil
	}
}
