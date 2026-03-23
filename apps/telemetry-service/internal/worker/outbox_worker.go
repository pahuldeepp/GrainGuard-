package worker

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
)

type OutboxWorker struct {
	pool         *pgxpool.Pool
	writer       *kafka.Writer
	pollInterval time.Duration
	batchLimit   int
	publishConc  int
}

func getenvInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func NewOutboxWorker(pool *pgxpool.Pool) *OutboxWorker {
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "kafka:9092"
	}

	brokerList := strings.Split(brokers, ",")

	writer := &kafka.Writer{
		Addr:         kafka.TCP(brokerList...),
		Topic:        "device.events",
		Balancer:     &kafka.LeastBytes{},
		RequiredAcks: kafka.RequireAll,
		BatchSize:    100,
		BatchTimeout: 10 * time.Millisecond,
	}

	return &OutboxWorker{
		pool:         pool,
		writer:       writer,
		pollInterval: time.Duration(getenvInt("OUTBOX_POLL_MS", 200)) * time.Millisecond,
		batchLimit:   getenvInt("OUTBOX_BATCH_LIMIT", 500),
		publishConc:  getenvInt("OUTBOX_PUBLISH_CONCURRENCY", 20),
	}
}

func (w *OutboxWorker) Start(ctx context.Context) {
	log.Printf("[outbox] worker started — poll=%s batch=%d concurrency=%d",
		w.pollInterval, w.batchLimit, w.publishConc)

	ticker := time.NewTicker(w.pollInterval)
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
		log.Println("[outbox] tx begin error:", err)
		return
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT id, event_type, payload
		FROM outbox_events
		WHERE published_at IS NULL
		ORDER BY created_at
		FOR UPDATE SKIP LOCKED
		LIMIT $1`, w.batchLimit)
	if err != nil {
		log.Println("[outbox] query error:", err)
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
			log.Println("[outbox] scan error:", err)
			continue
		}

		events = append(events, event{
			id:        id,
			eventType: eventType,
			payload:   payload,
		})
	}

	if err := rows.Err(); err != nil {
		log.Println("[outbox] rows iteration error:", err)
		return
	}

	if len(events) == 0 {
		return
	}

	log.Printf("[outbox] processing %d events", len(events))

	// ── Parallel publish with semaphore ──────────────────────────────────
	type result struct {
		idx     int
		id      string
		success bool
	}

	results := make([]result, len(events))
	sem := make(chan struct{}, w.publishConc)
	var wg sync.WaitGroup

	for i, e := range events {
		wg.Add(1)
		go func(idx int, evt event) {
			defer wg.Done()
			sem <- struct{}{}        // acquire
			defer func() { <-sem }() // release

			protoBytes, err := buildEnvelope(evt.id, evt.eventType, evt.payload)
			if err != nil {
				log.Printf("[outbox] build envelope error (id=%s type=%s): %v", evt.id, evt.eventType, err)
				results[idx] = result{idx: idx, id: evt.id, success: false}
				return
			}
			if protoBytes == nil {
				// unknown event type — mark published to avoid reprocessing
				results[idx] = result{idx: idx, id: evt.id, success: true}
				return
			}

			err = w.writer.WriteMessages(ctx,
				kafka.Message{
					Key:   []byte(evt.id),
					Value: protoBytes,
					Headers: []kafka.Header{
						{Key: "event_type", Value: []byte(evt.eventType)},
						{Key: "schema_version", Value: []byte("1")},
					},
				},
			)
			if err != nil {
				log.Printf("[outbox] kafka publish error (id=%s): %v", evt.id, err)
				results[idx] = result{idx: idx, id: evt.id, success: false}
				return
			}

			results[idx] = result{idx: idx, id: evt.id, success: true}
		}(i, e)
	}

	wg.Wait()

	// ── Mark published in batch ──────────────────────────────────────────
	published := 0
	for _, r := range results {
		if r.success {
			_, err = tx.Exec(ctx,
				`UPDATE outbox_events SET published_at = NOW() WHERE id = $1`,
				r.id)
			if err != nil {
				log.Printf("[outbox] update error (id=%s): %v", r.id, err)
				continue
			}
			published++
		}
	}

	if err := tx.Commit(ctx); err != nil {
		log.Println("[outbox] commit error:", err)
		return
	}

	if published > 0 {
		log.Printf("[outbox] published %d/%d events", published, len(events))
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
