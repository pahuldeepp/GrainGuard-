package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/segmentio/kafka-go"

	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/transform"
	"github.com/pahuldeepp/grainguard/libs/logger"
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
	logger.Init("cdc-transformer")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	brokers := brokersFromEnv(mustEnv("KAFKA_BROKERS", "kafka:9092"))
	sourceTopic := mustEnv("CDC_SOURCE_TOPIC", "grainguard.public.telemetry_readings")
	targetTopic := mustEnv("TARGET_TOPIC", "telemetry.events")
	groupID := mustEnv("KAFKA_GROUP_ID", "cdc-transformer")

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        groupID,
		Topic:          sourceTopic,
		MinBytes:       10e3,
		MaxBytes:       10e6,
		MaxWait:        500 * time.Millisecond,
		StartOffset:    kafka.FirstOffset,
		QueueCapacity:  1000,
		CommitInterval: 0,
	})
	defer func() {
		if err := reader.Close(); err != nil {
			log.Error().Err(err).Msg("reader close error")
		}
	}()

	writer := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        targetTopic,
		RequiredAcks: kafka.RequireAll,
		Async:        false,
		Balancer:     &kafka.Hash{},
		BatchSize:    batchSize,
		BatchTimeout: 50 * time.Millisecond,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}
	defer func() {
		if err := writer.Close(); err != nil {
			log.Error().Err(err).Msg("writer close error")
		}
	}()

	log.Info().
		Str("source_topic", sourceTopic).
		Str("target_topic", targetTopic).
		Strs("brokers", brokers).
		Str("group_id", groupID).
		Int("batch_size", batchSize).
		Dur("flush_interval", flushInterval).
		Msg("cdc-transformer started")

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
			log.Error().Err(err).Int("count", len(outMsgs)).Msg("batch produce error")
			return
		}
		if err := reader.CommitMessages(ctx, sourceMsgs...); err != nil {
			log.Error().Err(err).Int("count", len(sourceMsgs)).Msg("batch commit error")
			return
		}
		processed += len(sourceMsgs)
		if processed%logEvery == 0 || len(sourceMsgs) >= batchSize {
			last := sourceMsgs[len(sourceMsgs)-1]
			log.Info().
				Int("committed", len(sourceMsgs)).
				Int("total_processed", processed).
				Int64("last_offset", last.Offset).
				Msg("batch transformed")
		}
		sourceMsgs = sourceMsgs[:0]
		outMsgs = outMsgs[:0]
	}

	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("cdc-transformer shutting down")
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
				log.Error().Err(err).Msg("fetch error")
				time.Sleep(500 * time.Millisecond)
				continue
			}

			evt, err := transform.TransformTelemetry(msg.Value, msg.Topic, msg.Partition, msg.Offset)
			if err != nil {
				log.Warn().
					Err(err).
					Str("topic", msg.Topic).
					Int("partition", msg.Partition).
					Int64("offset", msg.Offset).
					Msg("transform skip")

				if commitErr := reader.CommitMessages(ctx, msg); commitErr != nil {
					log.Error().
						Err(commitErr).
						Int64("offset", msg.Offset).
						Msg("commit skip error")
				}
				skipped++
				continue
			}

			payload, err := transform.MarshalTelemetry(evt)
			if err != nil {
				log.Error().
					Err(err).
					Int64("offset", msg.Offset).
					Msg("marshal error")
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
				log.Info().
					Int("processed", processed).
					Int("skipped", skipped).
					Msg("progress")
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

