// review-sweep
package main

import (
	"context"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/segmentio/kafka-go"

	"github.com/pahuldeepp/grainguard/libs/logger"
)

func getenv(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func main() {
	logger.Init("dlq-reprocessor")

	brokers := strings.Split(getenv("KAFKA_BROKERS", "kafka:9092"), ",")

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		Topic:          "telemetry.events.dlq",
		GroupID:        "dlq-reprocessor",
		CommitInterval: 0,
		MinBytes:       1,
		MaxBytes:       10e6,
	})

	writer := &kafka.Writer{
		Addr:     kafka.TCP(brokers[0]),
		Topic:    "telemetry.events",
		Balancer: &kafka.LeastBytes{},
	}

	// Graceful shutdown via context — no os.Exit
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Info().Strs("brokers", brokers).Msg("DLQ reprocessor started")

	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				log.Info().Msg("context cancelled — shutting down")
				break
			}
			log.Error().Err(err).Msg("fetch error")
			continue
		}

		log.Info().
			Int64("offset", msg.Offset).
			Int("partition", msg.Partition).
			Msg("reprocessing DLQ message")

		err = retryWithBackoff(func() error {
			return writer.WriteMessages(ctx, kafka.Message{
				Key:     msg.Key,
				Value:   msg.Value,
				Headers: msg.Headers,
			})
		})

		if err != nil {
			log.Error().Err(err).Int64("offset", msg.Offset).Msg("republish failed after retries")
			continue
		}

		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Error().Err(err).Int64("offset", msg.Offset).Msg("commit failed")
			continue
		}

		log.Info().Int64("offset", msg.Offset).Msg("successfully reprocessed")
	}

	log.Info().Msg("DLQ reprocessor stopped")

	if err := reader.Close(); err != nil {
		log.Error().Err(err).Msg("reader close error")
	}
	if err := writer.Close(); err != nil {
		log.Error().Err(err).Msg("writer close error")
	}
}

func retryWithBackoff(fn func() error) error {
	maxAttempts := 5
	baseDelay := 500 * time.Millisecond
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		err = fn()
		if err == nil {
			return nil
		}
		delay := baseDelay * time.Duration(1<<attempt)
		log.Warn().Err(err).Int("attempt", attempt+1).Dur("retry_in", delay).Msg("republish failed, retrying")
		time.Sleep(delay)
	}
	return err
}
