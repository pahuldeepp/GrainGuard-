package kafka

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

type EventPublisher struct {
	writer *kafka.Writer
}

func NewEventPublisher(brokers []string, topic string) *EventPublisher {
	return &EventPublisher{
		writer: &kafka.Writer{
			Addr:     kafka.TCP(brokers...),
			Topic:    topic,
			Balancer: &kafka.Hash{},
		},
	}
}

func (p *EventPublisher) Publish(ctx context.Context, eventType, aggregateID, tenantID string, payload map[string]any) error {
	envelope := map[string]any{
		"event_id":          aggregateID + "-" + eventType,
		"event_type":        eventType,
		"aggregate_id":      aggregateID,
		"tenant_id":         tenantID,
		"occurred_at_unix_ms": time.Now().UnixMilli(),
		"payload":           payload,
	}

	data, err := json.Marshal(envelope)
	if err != nil {
		return err
	}

	err = p.writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(aggregateID),
		Value: data,
	})
	if err != nil {
		log.Printf("[asset-registry] publish error event=%s: %v", eventType, err)
	}
	return err
}
