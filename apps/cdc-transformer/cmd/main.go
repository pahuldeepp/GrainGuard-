package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/transform"
)

const (
	batchSize     = 500
	flushInterval = 500 * time.Millisecond
	logEvery      = 1000
)

func mustEnv(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}

func brokersFromEnv(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return []string{"kafka:9092"}
	}
	return out
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	brokers := brokersFromEnv(mustEnv("KAFKA_BROKERS", "kafka:9092"))
	sourceTopic := mustEnv("CDC_SOURCE_TOPIC", "grainguard.public.telemetry_readings")
	targetTopic := mustEnv("TARGET_TOPIC", "telemetry.events")
	groupID := mustEnv("KAFKA_GROUP_ID", "cdc-transformer")

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: brokers,
		GroupID: groupID,
		Topic:   sourceTopic,

		// Bigger fetches = far fewer round trips
		MinBytes: 10e3, // 10 KB
		MaxBytes: 10e6, // 10 MB
		MaxWait:  500 * time.Millisecond,

		// Keep first offset only for brand new consumer groups
		StartOffset: kafka.FirstOffset,

		// Queue a little more on the client side
		QueueCapacity: 1000,

		// We will commit in batches ourselves
		CommitInterval: 0,
	})
	defer func() {
		if err := reader.Close(); err != nil {
			log.Printf("reader close error: %v", err)
		}
	}()

	writer := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        targetTopic,
		RequiredAcks: kafka.RequireAll,

		// Keep synchronous delivery for safety, but batch it
		Async: false,

		Balancer: &kafka.Hash{},

		BatchSize:    batchSize,
		BatchTimeout: 50 * time.Millisecond,

		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}
	defer func() {
		if err := writer.Close(); err != nil {
			log.Printf("writer close error: %v", err)
		}
	}()

	log.Printf(
		"cdc-transformer started source=%s target=%s brokers=%v group=%s batchSize=%d flushInterval=%s",
		sourceTopic, targetTopic, brokers, groupID, batchSize, flushInterval,
	)

	var (
		sourceMsgs []kafka.Message
		outMsgs    []kafka.Message
		processed  int
		skipped    int
	)

	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()

	flush := func() {
		if len(outMsgs) == 0 {
			return
		}

		if err := writer.WriteMessages(ctx, outMsgs...); err != nil {
			log.Printf("batch produce error count=%d err=%v", len(outMsgs), err)
			return
		}

		if err := reader.CommitMessages(ctx, sourceMsgs...); err != nil {
			log.Printf("batch commit error count=%d err=%v", len(sourceMsgs), err)
			return
		}

		processed += len(sourceMsgs)

		if processed%logEvery == 0 || len(sourceMsgs) >= batchSize {
			last := sourceMsgs[len(sourceMsgs)-1]
			log.Printf(
				"batch transformed committed=%d total_processed=%d last_offset=%d",
				len(sourceMsgs), processed, last.Offset,
			)
		}

		sourceMsgs = sourceMsgs[:0]
		outMsgs = outMsgs[:0]
	}

	for {
		select {
		case <-ctx.Done():
			log.Println("cdc-transformer shutting down")
			flush()
			return

		case <-ticker.C:
			flush()

		default:
			msg, err := reader.FetchMessage(ctx)
			if err != nil {
				if ctx.Err() != nil || isSkippable(err) {
					flush()
					return
				}
				log.Printf("fetch error: %v", err)
				time.Sleep(500 * time.Millisecond)
				continue
			}

			evt, err := transform.TransformTelemetry(msg.Value, msg.Topic, msg.Partition, msg.Offset)
			if err != nil {
				// Skip tombstones / malformed envelopes / non-data events
				log.Printf(
					"transform skip topic=%s partition=%d offset=%d err=%v",
					msg.Topic, msg.Partition, msg.Offset, err,
				)

				if commitErr := reader.CommitMessages(ctx, msg); commitErr != nil {
					log.Printf("commit skip error topic=%s partition=%d offset=%d err=%v",
						msg.Topic, msg.Partition, msg.Offset, commitErr)
				}
				skipped++
				continue
			}

			payload, err := transform.MarshalTelemetry(evt)
			if err != nil {
				log.Printf(
					"marshal error topic=%s partition=%d offset=%d err=%v",
					msg.Topic, msg.Partition, msg.Offset, err,
				)
				continue
			}

			outMsg := kafka.Message{
				Key:   []byte(evt.AggregateID),
				Value: payload,
				Time:  time.Now().UTC(),
				Headers: []kafka.Header{
					{Key: "event_type", Value: []byte(evt.EventType)},
					{Key: "event_id", Value: []byte(evt.EventID)},
				},
			}

			sourceMsgs = append(sourceMsgs, msg)
			outMsgs = append(outMsgs, outMsg)

			if len(outMsgs) >= batchSize {
				flush()
			}

			if skipped > 0 && (processed+skipped)%logEvery == 0 {
				log.Printf("progress processed=%d skipped=%d", processed, skipped)
			}
		}
	}
}

func isSkippable(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, context.Canceled)
}