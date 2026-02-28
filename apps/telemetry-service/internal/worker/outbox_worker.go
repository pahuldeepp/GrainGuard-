package worker	

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"
)

type OutboxWorker struct {
	pool   *pgxpool.Pool
	writer *kafka.Writer
}

func NewOutboxWorker(pool *pgxpool.Pool) *OutboxWorker {

	writer := &kafka.Writer{
		Addr:     kafka.TCP("localhost:9092"),
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
		id      string
		payload []byte
	}

	var events []event

	for rows.Next() {
		var id string
		var eventType string
		var payload []byte

		if err := rows.Scan(&id, &eventType, &payload); err != nil {
			continue
		}

		events = append(events, event{id: id, payload: payload})
	}

	if len(events) == 0 {
		return
	}

	for _, e := range events {

		err := w.writer.WriteMessages(ctx,
			kafka.Message{
				Key:   []byte(e.id),
				Value: e.payload,
			},
		)
		if err != nil {
			log.Println("kafka publish error:", err)
			return
		}

		_, err = tx.Exec(ctx,
			`UPDATE outbox_events
			 SET published_at = NOW()
			 WHERE id = $1`, e.id)
		if err != nil {
			log.Println("update error:", err)
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		log.Println("commit error:", err)
	}
}