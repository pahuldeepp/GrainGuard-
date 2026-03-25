package consumer

import (
	"context"
	"errors"
	"log"
	"math"
	"math/rand"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/idempotency"
	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/transform"
	"github.com/pahuldeepp/grainguard/libs/observability"
)

type CDCConsumer struct {
	reader    *kafka.Reader
	writer    *kafka.Writer
	dlqWriter *kafka.Writer
	deduper   *idempotency.Deduper
}

type cdcJob struct {
	msg   kafka.Message
	topic string
}

type publishJob struct {
	sourceMsg  kafka.Message
	dedupeKey  string
	outMessage kafka.Message
}

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

func NewFromEnv(deduper *idempotency.Deduper) *CDCConsumer {
	brokers := getenv("KAFKA_BROKERS", "localhost:9092")
	brokerList := strings.Split(brokers, ",")

	cdcTopic := getenv("CDC_TOPIC", "grainguard.public.telemetry_readings")
	outTopic := getenv("OUT_TOPIC", "telemetry.events")
	dlqTopic := getenv("DLQ_TOPIC", outTopic+".dlq")
	groupID := getenv("GROUP_ID", "cdc-transformer")

	reader := kafka.NewReader(kafka.ReaderConfig{
    Brokers:        brokerList,
    Topic:          cdcTopic,
    GroupID:        groupID,
    MinBytes:       10e3,
    MaxBytes:       10e6,
    MaxWait:        500 * time.Millisecond,
    CommitInterval: 0,
})

	writer := &kafka.Writer{
    Addr:         kafka.TCP(brokerList...),
    Topic:        outTopic,
    Balancer:     &kafka.LeastBytes{},
    RequiredAcks: kafka.RequireAll,
    Async:        true,
    BatchSize:    100,
    BatchTimeout: 10 * time.Millisecond,
}

	dlqWriter := &kafka.Writer{
    Addr:         kafka.TCP(brokerList...),
    Topic:        dlqTopic,
    Balancer:     &kafka.LeastBytes{},
    RequiredAcks: kafka.RequireAll,
		Async:        false,
	}

	return &CDCConsumer{
		reader:    reader,
		writer:    writer,
		dlqWriter: dlqWriter,
		deduper:   deduper,
	}
}

func (c *CDCConsumer) Close() {
	_ = c.reader.Close()
	_ = c.writer.Close()
	_ = c.dlqWriter.Close()
}

func dedupeKey(topic string, partition int, offset int64) string {
	return "cdc:" + topic + ":" + strconv.Itoa(partition) + ":" + strconv.FormatInt(offset, 10)
}

func (c *CDCConsumer) Start(ctx context.Context) {
	topic := c.reader.Config().Topic

	workerCount := getenvInt("WORKER_COUNT", runtime.NumCPU()*2)
	publisherCount := getenvInt("PUBLISHER_COUNT", runtime.NumCPU())
	jobQueueSize := getenvInt("JOB_QUEUE_SIZE", 4096)
	publishQueueSize := getenvInt("PUBLISH_QUEUE_SIZE", 4096)
	commitQueueSize := getenvInt("COMMIT_QUEUE_SIZE", 4096)

	log.Printf(
		"cdc-transformer starting workers=%d publishers=%d jobQueue=%d publishQueue=%d commitQueue=%d",
		workerCount, publisherCount, jobQueueSize, publishQueueSize, commitQueueSize,
	)

	jobs := make(chan cdcJob, jobQueueSize)
	publishQueue := make(chan publishJob, publishQueueSize)
	commitQueue := make(chan kafka.Message, commitQueueSize)

	observability.WorkerQueueDepth.Set(0)
	observability.PublishQueueDepth.Set(0)
	observability.CommitQueueDepth.Set(0)

	var workerWG sync.WaitGroup
	var publisherWG sync.WaitGroup
	var commitWG sync.WaitGroup

	commitWG.Add(1)
	go func() {
		defer commitWG.Done()
		c.commitCoordinator(ctx, commitQueue)
	}()

	for i := 0; i < publisherCount; i++ {
		publisherWG.Add(1)
		go func(publisherID int) {
			defer publisherWG.Done()
			c.publisher(ctx, publisherID, publishQueue, commitQueue)
		}(i + 1)
	}

	for i := 0; i < workerCount; i++ {
		workerWG.Add(1)
		go func(workerID int) {
			defer workerWG.Done()
			c.worker(ctx, workerID, jobs, publishQueue)
		}(i + 1)
	}

fetchLoop:
	for {
		stats := c.reader.Stats()
		observability.KafkaConsumerLag.Set(float64(stats.Lag))

		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				log.Println("cdc-transformer fetch loop shutting down")
				break
			}

			log.Printf("fetch error: %v", err)
			observability.KafkaFetchErrors.Inc()
			time.Sleep(500 * time.Millisecond)
			continue
		}

		job := cdcJob{
			msg:   msg,
			topic: topic,
		}

		select {
		case jobs <- job:
			observability.WorkerQueueDepth.Set(float64(len(jobs)))
		case <-ctx.Done():
			break fetchLoop
		}
	}

	close(jobs)
	workerWG.Wait()

	close(publishQueue)
	publisherWG.Wait()

	close(commitQueue)
	commitWG.Wait()

	observability.WorkerQueueDepth.Set(0)
	observability.PublishQueueDepth.Set(0)
	observability.CommitQueueDepth.Set(0)

	log.Println("cdc-transformer stopped")
}

func (c *CDCConsumer) worker(
	ctx context.Context,
	workerID int,
	jobs <-chan cdcJob,
	publishQueue chan<- publishJob,
) {
	for {
		select {
		case job, ok := <-jobs:
			if !ok {
				return
			}

			observability.WorkerQueueDepth.Set(float64(len(jobs)))
			observability.InflightJobs.Inc()

			start := time.Now()
			err := c.processMessage(ctx, job, publishQueue)
			observability.EventProcessingLatency.Observe(time.Since(start).Seconds())
			observability.InflightJobs.Dec()

			if err != nil {
				observability.WorkerErrors.Inc()
				log.Printf("worker %d processing error: %v", workerID, err)
			}

		case <-ctx.Done():
			return
		}
	}
}

func (c *CDCConsumer) processMessage(
	ctx context.Context,
	job cdcJob,
	publishQueue chan<- publishJob,
) error {
	msg := job.msg
	topic := job.topic

	key := dedupeKey(topic, msg.Partition, msg.Offset)

	ok, err := c.deduper.Reserve(ctx, key)
	if err != nil {
		log.Printf("dedupe reserve error: %v", err)
		return err
	}

	if !ok {
		return c.commitNow(ctx, msg)
	}

	evt, err := transform.TransformTelemetry(msg.Value, topic, msg.Partition, msg.Offset)
	if err != nil {
		if isSkippable(err) {
			return c.commitNow(ctx, msg)
		}

		log.Printf("transform error: %v", err)
		_ = c.deduper.Cancel(ctx, key)
		return err
	}

	outBytes, err := transform.MarshalTelemetry(evt)
	if err != nil {
		log.Printf("marshal error: %v", err)
		_ = c.deduper.Cancel(ctx, key)
		return err
	}

	pubJob := publishJob{
		sourceMsg: msg,
		dedupeKey: key,
		outMessage: kafka.Message{
			Key:   []byte(evt.EventID),
			Value: outBytes,
			Headers: []kafka.Header{
				{Key: "eventType", Value: []byte(evt.EventType)},
				{Key: "eventId", Value: []byte(evt.EventID)},
			},
		},
	}

	select {
	case publishQueue <- pubJob:
		observability.PublishQueueDepth.Set(float64(len(publishQueue)))
		return nil
	case <-ctx.Done():
		_ = c.deduper.Cancel(ctx, key)
		return ctx.Err()
	}
}

func (c *CDCConsumer) publisher(
	ctx context.Context,
	publisherID int,
	publishQueue <-chan publishJob,
	commitQueue chan<- kafka.Message,
) {
	for {
		select {
		case job, ok := <-publishQueue:
			if !ok {
				return
			}

			observability.PublishQueueDepth.Set(float64(len(publishQueue)))

			err := retryWithBackoff(ctx, func() error {
				return c.writer.WriteMessages(ctx, job.outMessage)
			})

			if err != nil {
				log.Printf("publisher %d publish failed after retries: %v", publisherID, err)

				if dlqErr := c.writeToDLQ(ctx, job, err); dlqErr != nil {
					log.Printf("publisher %d dlq write failed: %v", publisherID, dlqErr)
					_ = c.deduper.Cancel(ctx, job.dedupeKey)
					continue
				}

				observability.EventsDLQ.Inc()
				observability.PublishDLQ.Inc()

				if err := c.deduper.Confirm(ctx, job.dedupeKey); err != nil {
					log.Printf("publisher %d dedupe confirm after dlq failed: %v", publisherID, err)
					continue
				}

				select {
				case commitQueue <- job.sourceMsg:
					observability.CommitQueueDepth.Set(float64(len(commitQueue)))
				case <-ctx.Done():
					return
				}

				continue
			}

			observability.PublishSuccess.Inc()

			if err := c.deduper.Confirm(ctx, job.dedupeKey); err != nil {
				log.Printf("publisher %d dedupe confirm error: %v", publisherID, err)
				continue
			}

			select {
			case commitQueue <- job.sourceMsg:
				observability.CommitQueueDepth.Set(float64(len(commitQueue)))
				observability.EventsProcessed.Inc()
			case <-ctx.Done():
				return
			}

		case <-ctx.Done():
			return
		}
	}
}

func (c *CDCConsumer) writeToDLQ(ctx context.Context, job publishJob, publishErr error) error {
	dlqMsg := kafka.Message{
		Key:   job.sourceMsg.Key,
		Value: job.sourceMsg.Value,
		Headers: []kafka.Header{
			{Key: "source_topic", Value: []byte(job.sourceMsg.Topic)},
			{Key: "source_partition", Value: []byte(strconv.Itoa(job.sourceMsg.Partition))},
			{Key: "source_offset", Value: []byte(strconv.FormatInt(job.sourceMsg.Offset, 10))},
			{Key: "error", Value: []byte(publishErr.Error())},
			{Key: "failed_at", Value: []byte(time.Now().UTC().Format(time.RFC3339Nano))},
			{Key: "dedupe_key", Value: []byte(job.dedupeKey)},
		},
	}

	return c.dlqWriter.WriteMessages(ctx, dlqMsg)
}

func (c *CDCConsumer) commitCoordinator(ctx context.Context, commitQueue <-chan kafka.Message) {
	const commitBatchSize = 128
	const commitFlushInterval = 100 * time.Millisecond

	batch := make([]kafka.Message, 0, commitBatchSize)
	timer := time.NewTimer(commitFlushInterval)
	defer timer.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := c.reader.CommitMessages(ctx, batch...); err != nil && !errors.Is(err, context.Canceled) {
			observability.CommitErrors.Inc()
			log.Printf("batch commit error (%d msgs): %v", len(batch), err)
		}
		batch = batch[:0]
	}

	for {
		select {
		case msg, ok := <-commitQueue:
			if !ok {
				flush()
				return
			}

			observability.CommitQueueDepth.Set(float64(len(commitQueue)))
			batch = append(batch, msg)

			if len(batch) >= commitBatchSize {
				flush()
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(commitFlushInterval)
			}

		case <-timer.C:
			flush()
			timer.Reset(commitFlushInterval)

		case <-ctx.Done():
			flush()
			return
		}
	}
}

func (c *CDCConsumer) commitNow(ctx context.Context, msg kafka.Message) error {
	if err := c.reader.CommitMessages(ctx, msg); err != nil {
		observability.CommitErrors.Inc()
		log.Printf("commit error partition=%d offset=%d err=%v", msg.Partition, msg.Offset, err)
		return err
	}
	return nil
}

func retryWithBackoff(ctx context.Context, fn func() error) error {
	const maxAttempts = 5
	baseDelay := 300 * time.Millisecond

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
		observability.PublishRetry.Inc()

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

func isSkippable(err error) bool {
	s := err.Error()

	return errors.Is(err, context.Canceled) ||
		strings.HasPrefix(s, "skip:")
}

