package consumer

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/pahuldeepp/grainguard/libs/observability"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

type KafkaConsumer struct {
	reader    *kafka.Reader
	dlqWriter *kafka.Writer
	topic     string
}

func NewKafkaConsumerFromEnv(topic string, groupID string) *KafkaConsumer {

	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "localhost:9092"
	}

	brokerList := strings.Split(brokers, ",")

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokerList,
		Topic:          topic,
		GroupID:        groupID,
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: 0,
		StartOffset:    kafka.FirstOffset,
	})

	dlqWriter := &kafka.Writer{
		Addr:     kafka.TCP(brokerList...),
		Topic:    topic + ".dlq",
		Balancer: &kafka.LeastBytes{},
	}

	return &KafkaConsumer{
		reader:    reader,
		dlqWriter: dlqWriter,
		topic:     topic,
	}
}

func (c *KafkaConsumer) Close() error {

	var err1, err2 error

	if c.reader != nil {
		err1 = c.reader.Close()
	}

	if c.dlqWriter != nil {
		err2 = c.dlqWriter.Close()
	}

	if err1 != nil {
		return err1
	}

	return err2
}

func (c *KafkaConsumer) sendToDLQ(ctx context.Context, msg kafka.Message, reason error) error {

	dlqMsg := kafka.Message{
		Key:   msg.Key,
		Value: msg.Value,
		Headers: append(msg.Headers,
			kafka.Header{Key: "x-error", Value: []byte(reason.Error())},
		),
	}

	return c.dlqWriter.WriteMessages(ctx, dlqMsg)
}

type job struct{ msg kafka.Message }

func (c *KafkaConsumer) Start(ctx context.Context, handler func(context.Context, []byte) error) {

	tracer := otel.Tracer("saga-orchestrator.kafka-consumer")

	const (
		workerCount = 16
		jobsBuffer  = 2000
		maxRetries  = 3
		retryDelay  = 2 * time.Second
	)

	type result struct {
		msg kafka.Message
		err error
	}

	jobs := make(chan job, jobsBuffer)
	results := make(chan result, jobsBuffer)

	var workersWG sync.WaitGroup

	for i := 0; i < workerCount; i++ {

		workersWG.Add(1)

		go func(workerID int) {

			defer workersWG.Done()

			for {

				select {

				case <-ctx.Done():
					return

				case j, ok := <-jobs:

					if !ok {
						return
					}

					msg := j.msg

					spanCtx, span := tracer.Start(ctx, "process_kafka_event")

					span.SetAttributes(
						attribute.String("kafka.topic", c.topic),
						attribute.Int64("kafka.partition", int64(msg.Partition)),
						attribute.Int64("kafka.offset", msg.Offset),
						attribute.Int("worker.id", workerID),
					)

					observability.InflightJobs.Inc()

					start := time.Now()

					var handlerErr error

					for attempt := 1; attempt <= maxRetries; attempt++ {

						handlerErr = handler(spanCtx, msg.Value)

						if handlerErr == nil {
							break
						}

						observability.EventsRetry.Inc()

						span.SetAttributes(
							attribute.String("error", handlerErr.Error()),
						)

						log.Printf(
							"[worker=%d partition=%d offset=%d] attempt=%d err=%v",
							workerID,
							msg.Partition,
							msg.Offset,
							attempt,
							handlerErr,
						)

						select {

						case <-ctx.Done():
							observability.InflightJobs.Dec()
							span.End()
							return

						case <-time.After(retryDelay):

						}
					}

					observability.EventProcessingLatency.Observe(time.Since(start).Seconds())

					observability.InflightJobs.Dec()

					span.End()

					select {

					case results <- result{msg: msg, err: handlerErr}:

					case <-ctx.Done():
						return
					}
				}
			}

		}(i)
	}

	var commitWG sync.WaitGroup

	commitWG.Add(1)

	go func() {

		defer commitWG.Done()

		for {

			select {

			case <-ctx.Done():
				return

			case r, ok := <-results:

				if !ok {
					return
				}

				if r.err != nil {

					if dlqErr := c.sendToDLQ(ctx, r.msg, r.err); dlqErr != nil {

						log.Printf(
							"[commit] DLQ failed partition=%d offset=%d: %v",
							r.msg.Partition,
							r.msg.Offset,
							dlqErr,
						)

						continue
					}

					observability.EventsDLQ.Inc()

				} else {

					observability.EventsProcessed.Inc()
				}

				commitCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)

				if err := c.reader.CommitMessages(commitCtx, r.msg); err != nil {

					log.Printf(
						"[commit] CommitMessages failed partition=%d offset=%d: %v",
						r.msg.Partition,
						r.msg.Offset,
						err,
					)
				}

				cancel()
			}
		}

	}()

	for {

		if ctx.Err() != nil {
			break
		}

		msg, err := c.reader.FetchMessage(ctx)

		if err != nil {

			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				break
			}

			observability.KafkaFetchErrors.Inc()

			log.Printf("FetchMessage error: %v", err)

			time.Sleep(time.Second)

			continue
		}

		select {

		case jobs <- job{msg: msg}:

		case <-ctx.Done():
			break
		}
	}

	close(jobs)

	workersWG.Wait()

	close(results)

	commitWG.Wait()
}
