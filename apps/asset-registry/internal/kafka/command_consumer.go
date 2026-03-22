package kafka

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

type CommandHandler interface {
	HandleAttachDevice(ctx context.Context, deviceID, tenantID, correlationID string) error
	HandleAllocateQuota(ctx context.Context, deviceID, tenantID, correlationID string) error
	HandleDetachDevice(ctx context.Context, deviceID, tenantID, correlationID string) error
}

type CommandConsumer struct {
	reader  *kafka.Reader
	handler CommandHandler
}

func NewCommandConsumer(brokers []string, topic, groupID string, handler CommandHandler) *CommandConsumer {
	return &CommandConsumer{
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers: brokers,
			Topic:   topic,
			GroupID: groupID,
		}),
		handler: handler,
	}
}

func (c *CommandConsumer) Start(ctx context.Context) {
	log.Println("[asset-registry] command consumer started")
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Println("[asset-registry] fetch error:", err)
			continue
		}

		var cmd map[string]any
		if err := json.Unmarshal(msg.Value, &cmd); err != nil {
			log.Println("[asset-registry] unmarshal error:", err)
			_ = c.reader.CommitMessages(ctx, msg)
			continue
		}

		cmdType, _      := cmd["command_type"].(string)
		deviceID, _     := cmd["device_id"].(string)
		tenantID, _     := cmd["tenant_id"].(string)
		correlationID, _ := cmd["correlation_id"].(string)

		var handleErr error
		switch cmdType {
		case "tenant.attach_device":
			handleErr = c.handler.HandleAttachDevice(ctx, deviceID, tenantID, correlationID)
		case "quota.allocate_device":
			handleErr = c.handler.HandleAllocateQuota(ctx, deviceID, tenantID, correlationID)
		case "tenant.detach_device":
			handleErr = c.handler.HandleDetachDevice(ctx, deviceID, tenantID, correlationID)
		default:
			log.Println("[asset-registry] unknown command:", cmdType)
		}

		if handleErr != nil {
			log.Printf("[asset-registry] handle error cmd=%s: %v", cmdType, handleErr)
		}

		_ = c.reader.CommitMessages(ctx, msg)
	}
}
