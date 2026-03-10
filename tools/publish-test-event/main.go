package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/google/uuid"
    "github.com/segmentio/kafka-go"
    "google.golang.org/protobuf/proto"

    eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
)

func publishEvent(writer *kafka.Writer, deviceID, tenantID, eventType string) {
    envelope := &eventspb.EventEnvelope{
        EventId:          uuid.New().String(),
        EventType:        eventType,
        SchemaVersion:    1,
        OccurredAtUnixMs: time.Now().UnixMilli(),
        TenantId:         tenantID,
        AggregateId:      deviceID,
    }

    // Only set DeviceCreatedV1 payload for device_created_v1
    if eventType == "device_created_v1" {
        envelope.Payload = &eventspb.EventEnvelope_DeviceCreatedV1{
            DeviceCreatedV1: &eventspb.DeviceCreatedV1{
                DeviceId:  deviceID,
                TenantId:  tenantID,
                Serial:    "TEST-SERIAL-001",
                CreatedAt: time.Now().Format(time.RFC3339),
            },
        }
    }

    bytes, err := proto.Marshal(envelope)
    if err != nil {
        log.Fatalf("failed to marshal: %v", err)
    }

    err = writer.WriteMessages(context.Background(), kafka.Message{
        Key:   []byte(deviceID),
        Value: bytes,
    })
    if err != nil {
        log.Fatalf("failed to publish %s: %v", eventType, err)
    }

    fmt.Printf("Published %s for device_id=%s\n", eventType, deviceID)
}

func main() {
    deviceID := uuid.New().String()
    tenantID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

    writer := &kafka.Writer{
        Addr:     kafka.TCP("kafka:9092"),
        Topic:    "device.events",
        Balancer: &kafka.LeastBytes{},
    }
    defer writer.Close()

    // Step 1: start saga
    publishEvent(writer, deviceID, tenantID, "device_created_v1")
    time.Sleep(2 * time.Second)

    // Step 2: tenant attached
    publishEvent(writer, deviceID, tenantID, "tenant_attached_v1")
    time.Sleep(2 * time.Second)

    // Step 3: quota allocation failed ? trigger compensation
    publishEvent(writer, deviceID, tenantID, "tenant_detached_v1")
    time.Sleep(2 * time.Second)

    fmt.Println("Done. Check sagas table.")
}
