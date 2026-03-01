package consumer

import (
	"context"
	"log"
	"math"
	"math/rand"
	"os"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"

	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/observability"
)

type KafkaConsumer struct {
	reader    *kafka.Reader
	dlqWriter *kafka.Writer
	breaker   *CircuitBreaker
}

func NewKafkaConsumerFromEnv() *KafkaConsumer {
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "localhost:9092"
	}

	brokerList := strings.Split(brokers, ",")

	return &KafkaConsumer{
		breaker: NewCircuitBreaker(5, 20*time.Second),

		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers:        brokerList,
			Topic:          "telemetry.events",
			GroupID:        "read-model-builder",
			MinBytes:       1,
			MaxBytes:       10e6,
			CommitInterval: 0, // manual commit
		}),

		dlqWriter: &kafka.Writer{
			Addr:     kafka.TCP(brokerList...),
			Topic:    "telemetry.events.dlq",
			Balancer: &kafka.LeastBytes{},
		},
	}
}

func (c *KafkaConsumer) Start(ctx context.Context, handler func([]byte) error) {
	tracer := otel.Tracer("read-model-builder.consumer")

	for {
		// Update consumer lag at top of loop
		stats := c.reader.Stats()
		observability.KafkaConsumerLag.Set(float64(stats.Lag))

		// Circuit breaker guard
		if !c.breaker.Allow() {
			log.Println("Circuit breaker OPEN — pausing consumption")
			observability.CircuitBreakerState.Set(1)
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			continue
		}

		// Breaker allowed → HALF-OPEN or CLOSED
		observability.CircuitBreakerState.Set(2)

		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			// Check if context was cancelled (graceful shutdown)
			if ctx.Err() != nil {
				log.Println("Consumer shutting down")
				return
			}
			log.Println("Kafka fetch error:", err)
			observability.KafkaFetchErrors.Inc()
			c.breaker.Failure()
			time.Sleep(1 * time.Second)
			continue
		}

		msgCtx, span := tracer.Start(ctx, "process_message")
		span.SetAttributes(
			attribute.String("kafka.topic", msg.Topic),
			attribute.Int64("kafka.partition", int64(msg.Partition)),
			attribute.Int64("kafka.offset", msg.Offset),
		)

		err = retryWithBackoff(ctx, func() error {
			return handler(msg.Value)
		})

		if err != nil {
			span.RecordError(err)
			log.Println("Handler failed after retries. Sending to DLQ:", err)

			observability.EventsDLQ.Inc()

			dlqErr := c.dlqWriter.WriteMessages(msgCtx, kafka.Message{
				Key:   msg.Key,
				Value: msg.Value,
				Headers: []kafka.Header{
					{Key: "source_topic", Value: []byte(msg.Topic)},
					{Key: "error", Value: []byte(err.Error())},
				},
			})

			if dlqErr != nil {
				c.breaker.Failure()
				span.RecordError(dlqErr)
				log.Println("DLQ write failed:", dlqErr)
				span.End()
				continue
			}

			if commitErr := c.reader.CommitMessages(msgCtx, msg); commitErr != nil {
				c.breaker.Failure()
				span.RecordError(commitErr)
				log.Println("Commit after DLQ failed:", commitErr)
				span.End()
				continue
			}

			c.breaker.Failure()
			span.End()
			continue
		}

		// Success path
		if commitErr := c.reader.CommitMessages(msgCtx, msg); commitErr != nil {
			c.breaker.Failure()
			span.RecordError(commitErr)
			log.Println("Commit failed:", commitErr)
			span.End()
			continue
		}

		c.breaker.Success()
		observability.EventsProcessed.Inc()
		observability.CircuitBreakerState.Set(0)

		span.End()
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

		observability.EventsRetry.Inc()

		exp := time.Duration(math.Pow(2, float64(attempt))) * baseDelay
		jitter := time.Duration(rand.Int63n(int64(baseDelay)))

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(exp + jitter):
		}
	}

	return err
}
