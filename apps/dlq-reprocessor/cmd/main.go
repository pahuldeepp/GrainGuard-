package main

import (
	"context"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
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

func main() {
	logger.Init("dlq-reprocessor")

	brokers := strings.Split(getenv("KAFKA_BROKERS", "kafka:9092"), ",")
	workerCount := getenvInt("WORKER_COUNT", 20)
	channelSize := getenvInt("CHANNEL_SIZE", 4096)

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		Topic:          "telemetry.events.dlq",
		GroupID:        "dlq-reprocessor",
		CommitInterval: 0,
		MinBytes:       1,
		MaxBytes:       10e6,
	})

	writer := &kafka.Writer{
		Addr:         kafka.TCP(brokers[0]),
		Topic:        "telemetry.events",
		Balancer:     &kafka.LeastBytes{},
		BatchSize:    50,
		BatchTimeout: 10 * time.Millisecond,
	}

	// Graceful shutdown via context
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Info().
		Strs("brokers", brokers).
		Int("workers", workerCount).
		Msg("DLQ reprocessor started")

	// ── Worker pool ──────────────────────────────────────────────────────
	jobs := make(chan kafka.Message, channelSize)
	var wg sync.WaitGroup

	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for msg := range jobs {
				log.Info().
					Int("worker", workerID).
					Int64("offset", msg.Offset).
					Int("partition", msg.Partition).
					Msg("reprocessing DLQ message")

				err := retryWithBackoff(ctx, func() error {
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
		}(i)
	}

	// ── Fetch loop ───────────────────────────────────────────────────────
	go func() {
		for {
			msg, err := reader.FetchMessage(ctx)
			if err != nil {
				if ctx.Err() != nil {
					break
				}
				log.Error().Err(err).Msg("fetch error")
				continue
			}

			select {
			case jobs <- msg:
			case <-ctx.Done():
				break
			}
		}
		close(jobs)
	}()

	<-ctx.Done()
	log.Info().Msg("shutting down — draining workers...")
	wg.Wait()

	log.Info().Msg("DLQ reprocessor stopped")

	if err := reader.Close(); err != nil {
		log.Error().Err(err).Msg("reader close error")
	}
	if err := writer.Close(); err != nil {
		log.Error().Err(err).Msg("writer close error")
	}
}

func retryWithBackoff(ctx context.Context, fn func() error) error {
	maxAttempts := 5
	baseDelay := 500 * time.Millisecond
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err = fn()
		if err == nil {
			return nil
		}
		delay := baseDelay * time.Duration(1<<attempt)
		log.Warn().Err(err).Int("attempt", attempt+1).Dur("retry_in", delay).Msg("republish failed, retrying")
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return err
}
