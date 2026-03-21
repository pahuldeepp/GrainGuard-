// review-sweep
package worker

import (
	"context"
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
		Topic:    "telemetry.events",
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
		SELECT id, event_type, payload_bytes
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

		// 🔥 Unmarshal protobuf envelope (only to extract key)
		var env eventspb.EventEnvelope
		if err := proto.Unmarshal(e.payload, &env); err != nil {
			log.Println("protobuf unmarshal error:", err)
			continue
		}

		key := []byte(env.AggregateId)

		err := w.writer.WriteMessages(ctx,
			kafka.Message{
				Key:   key,
				Value: e.payload, // raw protobuf bytes
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