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
			Addr:     kafka.TCP(brokerList[0]),
			Topic:    "telemetry.events.dlq",
			Balancer: &kafka.LeastBytes{},
		},
	}
}

func (c *KafkaConsumer) Start(ctx context.Context, handler func([]byte) error) {
	tracer := otel.Tracer("read-model-builder.consumer")

	for {

		// Circuit breaker gate
		if !c.breaker.Allow() {
			log.Println("Circuit breaker OPEN — pausing consumption")
			observability.CircuitBreakerState.Set(1)
			time.Sleep(2 * time.Second)
			continue
		}

		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			log.Println("Kafka fetch error:", err)
			c.breaker.Failure()
			time.Sleep(1 * time.Second)
			continue
		}

		// Update lag metric
		stats := c.reader.Stats()
		observability.KafkaConsumerLag.Set(float64(stats.Lag))

		// Start tracing span
		msgCtx, span := tracer.Start(ctx, "process_message")
		span.SetAttributes(
			attribute.String("kafka.topic", msg.Topic),
			attribute.Int64("kafka.partition", int64(msg.Partition)),
			attribute.Int64("kafka.offset", msg.Offset),
		)

		// Retry handler
		err = retryWithBackoff(func() error {
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
				span.End()
				panic(dlqErr)
			}

			if commitErr := c.reader.CommitMessages(msgCtx, msg); commitErr != nil {
				c.breaker.Failure()
				span.RecordError(commitErr)
				span.End()
				panic(commitErr)
			}

			c.breaker.Failure()
			span.End()
			continue
		}

		// Success path
		if commitErr := c.reader.CommitMessages(msgCtx, msg); commitErr != nil {
			c.breaker.Failure()
			span.RecordError(commitErr)
			span.End()
			panic(commitErr)
		}

		c.breaker.Success()
		observability.EventsProcessed.Inc()
		observability.CircuitBreakerState.Set(0)

		span.End()
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

		observability.EventsRetry.Inc()

		exp := time.Duration(math.Pow(2, float64(attempt))) * baseDelay
		jitter := time.Duration(rand.Int63n(int64(baseDelay)))

		time.Sleep(exp + jitter)
	}

	return err
}
