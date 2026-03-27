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

	"github.com/pahuldeepp/grainguard/libs/correlationid"
	"github.com/pahuldeepp/grainguard/libs/observability"
)

const (
	batchSize    = 256                   // max events per batch before flushing
	batchTimeout = 50 * time.Millisecond // max wait before flushing a partial batch
)

type KafkaConsumer struct {
	reader    *kafka.Reader
	dlqWriter *kafka.Writer
	breaker   *CircuitBreaker
}

func NewKafkaConsumerFromEnv(topic string, groupID string) *KafkaConsumer {
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "localhost:9092"
	}

	brokerList := strings.Split(brokers, ",")

	return &KafkaConsumer{
		breaker: NewCircuitBreaker(5, 20*time.Second),

		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers:        brokerList,
			Topic:          topic,
			GroupID:        groupID,
			StartOffset:    kafka.LastOffset,
				MinBytes:       10e3,
			MaxBytes:       10e6,
			MaxWait:        500 * time.Millisecond,
			CommitInterval: 0,
		}),

		dlqWriter: &kafka.Writer{
			Addr:     kafka.TCP(brokerList...),
			Topic:    topic + ".dlq",
			Balancer: &kafka.LeastBytes{},
		},
	}
}

// Start runs the consumer with single-message processing.
// Kept for backwards compatibility via NewEnvelopeHandler.
func (c *KafkaConsumer) Start(
	ctx context.Context,
	workerCount int,
	handler func(context.Context, []byte) error,
) {
	jobs := make(chan kafka.Message, 2000)

	for i := 0; i < workerCount; i++ {
		go func(workerID int) {
			workerTracer := otel.Tracer("read-model-builder.worker")

			for msg := range jobs {
				// Extract correlation ID from Kafka message header
				msgCtx := ctx
				for _, h := range msg.Headers {
					if h.Key == "x-request-id" && len(h.Value) > 0 {
						msgCtx = correlationid.WithContext(msgCtx, string(h.Value))
						break
					}
				}

				corrID := correlationid.FromContext(msgCtx)
				msgCtx, span := workerTracer.Start(msgCtx, "process_message")
				span.SetAttributes(
					attribute.String("kafka.topic", msg.Topic),
					attribute.Int64("kafka.partition", int64(msg.Partition)),
					attribute.Int64("kafka.offset", msg.Offset),
				)
				if corrID != "" {
					span.SetAttributes(attribute.String("x-request-id", corrID))
				}

				err := retryWithBackoff(msgCtx, func() error {
					return handler(msgCtx, msg.Value)
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
						log.Println("DLQ write failed:", dlqErr)
						span.RecordError(dlqErr)
						span.End()
						continue
					}

					if commitErr := c.reader.CommitMessages(msgCtx, msg); commitErr != nil {
						log.Println("Commit after DLQ failed:", commitErr)
						span.RecordError(commitErr)
						span.End()
						continue
					}

					span.End()
					continue
				}

				if commitErr := c.reader.CommitMessages(msgCtx, msg); commitErr != nil {
					log.Println("Commit failed:", commitErr)
					span.RecordError(commitErr)
					span.End()
					continue
				}

				observability.EventsProcessed.Inc()
				span.End()
			}
		}(i)
	}

	log.Printf("Kafka consumer started with %d workers", workerCount)
	c.runFetchLoop(ctx, jobs)
}

// StartBatch runs the high-throughput batch accumulator.
//
// Each worker goroutine:
//  1. Reads messages from the jobs channel
//  2. Accumulates up to batchSize messages OR waits batchTimeout
//  3. Calls batchHandler with all payloads in one call
//  4. Commits all messages in one CommitMessages call
//  5. On failure: sends each message to DLQ individually
//
// Result: N messages → 1 DB transaction + 1 Redis pipeline + 1 Kafka commit
func (c *KafkaConsumer) StartBatch(
	ctx context.Context,
	workerCount int,
	batchHandler func(context.Context, [][]byte) error,
) {
	jobs := make(chan kafka.Message, 2000)

	for i := 0; i < workerCount; i++ {
		go func(workerID int) {
			tracer := otel.Tracer("read-model-builder.batch-worker")

			// Pre-allocate — reused each flush to reduce GC pressure
			batch := make([]kafka.Message, 0, batchSize)
			payloads := make([][]byte, 0, batchSize)
			timer := time.NewTimer(batchTimeout)
			defer timer.Stop()

			flush := func() {
				if len(batch) == 0 {
					return
				}

				// Use correlation ID from first message in batch for span attribution
				batchCtx := ctx
				for _, h := range batch[0].Headers {
					if h.Key == "x-request-id" && len(h.Value) > 0 {
						batchCtx = correlationid.WithContext(batchCtx, string(h.Value))
						break
					}
				}
				corrID := correlationid.FromContext(batchCtx)
				batchCtx, span := tracer.Start(batchCtx, "process_batch")
				span.SetAttributes(
					attribute.Int("batch.size", len(batch)),
					attribute.String("kafka.topic", batch[0].Topic),
				)
				if corrID != "" {
					span.SetAttributes(attribute.String("x-request-id", corrID))
				}

				err := retryWithBackoff(batchCtx, func() error {
					return batchHandler(batchCtx, payloads)
				})

				if err != nil {
					// Batch failed after all retries — DLQ each message individually
					span.RecordError(err)
					log.Printf("[batch-worker=%d] batch failed, sending %d msgs to DLQ: %v",
						workerID, len(batch), err)

					for _, msg := range batch {
						observability.EventsDLQ.Inc()
						_ = c.dlqWriter.WriteMessages(batchCtx, kafka.Message{
							Key:   msg.Key,
							Value: msg.Value,
							Headers: []kafka.Header{
								{Key: "source_topic", Value: []byte(msg.Topic)},
								{Key: "error", Value: []byte(err.Error())},
							},
						})
					}
				}

				// Commit all messages in batch in one call
				// kafka-go automatically uses the highest offset per partition
				if commitErr := c.reader.CommitMessages(batchCtx, batch...); commitErr != nil {
					log.Printf("[batch-worker=%d] batch commit failed: %v", workerID, commitErr)
					span.RecordError(commitErr)
				}

				span.End()

				// Reset — reuse allocated memory
				batch = batch[:0]
				payloads = payloads[:0]
			}

			for {
				// Reset timer for each new batch window
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(batchTimeout)

			accumulate:
				for len(batch) < batchSize {
					select {
					case msg, ok := <-jobs:
						if !ok {
							// Channel closed on shutdown — flush and exit
							flush()
							return
						}
						batch = append(batch, msg)
						payloads = append(payloads, msg.Value)

					case <-timer.C:
						// Timeout — flush partial batch
						break accumulate

					case <-ctx.Done():
						flush()
						return
					}
				}

				flush()
			}
		}(i)
	}

	log.Printf("Kafka batch consumer started: workers=%d batchSize=%d timeout=%s",
		workerCount, batchSize, batchTimeout)

	c.runFetchLoop(ctx, jobs)
}

// runFetchLoop is shared by Start and StartBatch.
// Reads from Kafka and pushes into jobs channel with circuit breaker
// protection and lag metrics.
func (c *KafkaConsumer) runFetchLoop(ctx context.Context, jobs chan kafka.Message) {
	for {
		stats := c.reader.Stats()
		observability.KafkaConsumerLag.Set(float64(stats.Lag))

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

		observability.CircuitBreakerState.Set(2)

		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				log.Println("Consumer shutting down")
				close(jobs)
				return
			}

			log.Println("Kafka fetch error:", err)
			observability.KafkaFetchErrors.Inc()
			c.breaker.Failure()
			time.Sleep(1 * time.Second)
			continue
		}

		jobs <- msg
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
