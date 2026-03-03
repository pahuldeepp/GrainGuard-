package consumer

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
)

type KafkaConsumer struct {
	reader *kafka.Reader
}

func NewKafkaConsumerFromEnv(topic string, groupID string) *KafkaConsumer {
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "localhost:9092"
	}
	brokerList := strings.Split(brokers, ",")

	return &KafkaConsumer{
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers:        brokerList,
			Topic:          topic,
			GroupID:        groupID,
			MinBytes:       1,
			MaxBytes:       10e6,
			CommitInterval: 0, // manual commit
		}),
	}
}

func (c *KafkaConsumer) Start(ctx context.Context, handler func([]byte) error) {
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				log.Println("Saga consumer shutting down")
				return
			}
			log.Println("Saga consumer fetch error:", err)
			time.Sleep(1 * time.Second)
			continue
		}

		if err := handler(msg.Value); err != nil {
			log.Println("Saga handler error:", err)
			// You can add DLQ later; for now don't commit so it retries.
			continue
		}

		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			log.Println("Saga commit error:", err)
			continue
		}
	}
}