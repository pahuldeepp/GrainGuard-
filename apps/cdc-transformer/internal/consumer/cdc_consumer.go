package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/idempotency"
	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/transform"
)

type CDCConsumer struct {
	reader  *kafka.Reader
	writer  *kafka.Writer
	deduper *idempotency.Deduper
}

func getenv(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func NewFromEnv(deduper *idempotency.Deduper) *CDCConsumer {
	brokers := getenv("KAFKA_BROKERS", "localhost:9092")
	brokerList := strings.Split(brokers, ",")

	cdcTopic := getenv("CDC_TOPIC", "grainguard.public.telemetry_readings")
	outTopic := getenv("OUT_TOPIC", "telemetry.events")
	groupID := getenv("GROUP_ID", "cdc-transformer")

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokerList,
		Topic:          cdcTopic,
		GroupID:        groupID,
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: 0, // manual commit
	})

	writer := &kafka.Writer{
		Addr:     kafka.TCP(brokerList...),
		Topic:    outTopic,
		Balancer: &kafka.LeastBytes{},
	}

	return &CDCConsumer{
		reader:  reader,
		writer:  writer,
		deduper: deduper,
	}
}

func (c *CDCConsumer) Close() {
	_ = c.reader.Close()
	_ = c.writer.Close()
}

func dedupeKey(topic string, partition int, offset int64) string {
	return "cdc:" + topic + ":" + strconv.Itoa(partition) + ":" + strconv.FormatInt(offset, 10)
}

func (c *CDCConsumer) Start(ctx context.Context) {

	topic := c.reader.Config().Topic

	for {

		msg, err := c.reader.FetchMessage(ctx)

		if err != nil {

			if ctx.Err() != nil {
				log.Println("cdc-transformer shutting down")
				return
			}

			log.Printf("fetch error: %v", err)
			time.Sleep(time.Second)
			continue
		}

		// -------------------------------
		// STEP 1 — Reserve dedupe key
		// -------------------------------

		key := dedupeKey(topic, msg.Partition, msg.Offset)

		ok, err := c.deduper.Reserve(ctx, key)

		if err != nil {

			log.Printf("dedupe reserve error: %v", err)

			// retry later (do NOT commit)
			continue
		}

		if !ok {

			// duplicate event
			_ = c.reader.CommitMessages(ctx, msg)

			continue
		}

		// -------------------------------
		// STEP 2 — Transform Debezium event
		// -------------------------------

		evt, err := transform.TransformTelemetry(msg.Value)

		if err != nil {

			if isSkippable(err) {

				_ = c.reader.CommitMessages(ctx, msg)

				continue
			}

			log.Printf("transform error: %v", err)

			// release reservation so it can retry
			_ = c.deduper.Cancel(ctx, key)

			continue
		}

		outBytes, err := json.Marshal(evt)

		if err != nil {

			log.Printf("marshal error: %v", err)

			_ = c.deduper.Cancel(ctx, key)

			continue
		}

		// -------------------------------
		// STEP 3 — Publish clean event
		// -------------------------------

		err = c.writer.WriteMessages(ctx, kafka.Message{
			Key:   []byte(evt.AggregateID),
			Value: outBytes,
			Headers: []kafka.Header{
				{Key: "eventType", Value: []byte(evt.EventType)},
			},
		})

		if err != nil {

			log.Printf("publish error: %v", err)

			// release reservation
			_ = c.deduper.Cancel(ctx, key)

			continue
		}

		// -------------------------------
		// STEP 4 — Confirm dedupe
		// -------------------------------

		_ = c.deduper.Confirm(ctx, key)

		// -------------------------------
		// STEP 5 — Commit CDC message
		// -------------------------------

		if err := c.reader.CommitMessages(ctx, msg); err != nil {

			log.Printf("commit error: %v", err)

			continue
		}
	}
}

func isSkippable(err error) bool {

	s := err.Error()

	return errors.Is(err, context.Canceled) ||
		strings.HasPrefix(s, "skip:")
}