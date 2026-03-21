package producer

import (
	"context"
	"os"
	"strings"

	"github.com/segmentio/kafka-go"
)

type Producer struct {
	writer *kafka.Writer
}

func NewProducerFromEnv(topic string) *Producer {
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "localhost:9092"
	}
	brokerList := strings.Split(brokers, ",")

	return &Producer{
		writer: &kafka.Writer{
			Addr:     kafka.TCP(brokerList...),
			Topic:    topic,
			Balancer: &kafka.LeastBytes{},
		},
	}
}

func (p *Producer) Publish(ctx context.Context, key []byte, value []byte) error {
	return p.writer.WriteMessages(ctx, kafka.Message{
		Key:   key,
		Value: value,
	})
}

func (p *Producer) Close() error {
	return p.writer.Close()
}
