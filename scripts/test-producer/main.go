// review-sweep
package main

import (
	"context"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
)

func main() {
	ctx := context.Background()

	writer := &kafka.Writer{
		Addr:     kafka.TCP("localhost:9092"),
		Topic:    "device.events",
		Balancer: &kafka.LeastBytes{},
	}

	env := &eventspb.EventEnvelope{
		EventId:          "test-event-1",
		EventType:        "device.created",
		SchemaVersion:    1,
		OccurredAtUnixMs: time.Now().UnixMilli(),
		TenantId:         "tenant-a",
		AggregateId:      "11111111-1111-1111-1111-111111111111",
		Payload: &eventspb.EventEnvelope_DeviceCreatedV1{
			DeviceCreatedV1: &eventspb.DeviceCreatedV1{
				DeviceId:  "11111111-1111-1111-1111-111111111111",
				TenantId:  "tenant-a",
				Serial:    "SERIAL-001",
				CreatedAt: time.Now().Format(time.RFC3339),
			},
		},
	}

	bytes, err := proto.Marshal(env)
	if err != nil {
		log.Fatal(err)
	}

	err = writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(env.AggregateId),
		Value: bytes,
	})

	if err != nil {
		log.Fatal(err)
	}

	log.Println("Published device.created protobuf event")
}