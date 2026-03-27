package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/segmentio/kafka-go"
)

func getenv(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func main() {

	brokers := strings.Split(getenv("KAFKA_BROKERS", "kafka:9092"), ",")

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		Topic:          "telemetry.events.dlq",
		GroupID:        "dlq-reprocessor",
		CommitInterval: 0, // manual commit
		MinBytes:       1,
		MaxBytes:       10e6,
	})

	writer := &kafka.Writer{
		Addr:     kafka.TCP(brokers[0]),
		Topic:    "telemetry.events",
		Balancer: &kafka.LeastBytes{},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go handleShutdown(cancel)

	log.Println("DLQ reprocessor started")

	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			log.Println("Fetch error:", err)
			continue
		}

		log.Printf("Reprocessing DLQ message offset=%d\n", msg.Offset)

		// Retry republish
		err = retryWithBackoff(func() error {
			return writer.WriteMessages(ctx, kafka.Message{
				Key:     msg.Key,
				Value:   msg.Value,
				Headers: msg.Headers,
			})
		})

		if err != nil {
			log.Println("Republish failed after retries:", err)
			continue // DO NOT COMMIT — will retry
		}

		// Commit only after successful republish
		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Println("Commit failed:", err)
			continue
		}

		log.Printf("Successfully reprocessed offset=%d\n", msg.Offset)
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
		time.Sleep(delay)
	}
	return err
}

func handleShutdown(cancel context.CancelFunc) {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("Shutdown signal received")
	cancel()
	time.Sleep(1 * time.Second)
	os.Exit(0)
}
