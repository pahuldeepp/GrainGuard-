package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"time"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

type TelemetryEvent struct {
	EventID     string  `json:"eventId"`
	EventType   string  `json:"eventType"`
	AggregateID string  `json:"aggregateId"`
	OccurredAt  string  `json:"occurredAt"`
	Data        TelData `json:"data"`
}

type TelData struct {
	DeviceID    string  `json:"deviceId"`
	Temperature float64 `json:"temperature"`
	Humidity    float64 `json:"humidity"`
	TenantID    string  `json:"tenantId"`
}

func main() {
	w := &kafka.Writer{
		Addr:     kafka.TCP("grainguard-kafka:9092"),
		Topic:    "telemetry.events",
		Balancer: &kafka.LeastBytes{},
	}
	defer w.Close()

	deviceID := "4f740e87-c3bc-454c-9b13-6f56101ff73a" // bench-device-138
	tenantID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

	for i := 0; i < 20; i++ {
		event := TelemetryEvent{
			EventID:     uuid.New().String(),
			EventType:   "telemetry.recorded",
			AggregateID: deviceID,
			OccurredAt:  time.Now().Add(-time.Duration(20-i) * time.Minute).Format(time.RFC3339Nano),
			Data: TelData{
				DeviceID:    deviceID,
				Temperature: 10 + rand.Float64()*30,
				Humidity:    20 + rand.Float64()*60,
				TenantID:    tenantID,
			},
		}

		payload, _ := json.Marshal(event)
		err := w.WriteMessages(context.Background(), kafka.Message{
			Key:   []byte(deviceID),
			Value: payload,
		})
		if err != nil {
			log.Fatalf("failed to write message: %v", err)
		}
		fmt.Printf("Published telemetry %d: temp=%.1f humidity=%.1f\n", i+1, event.Data.Temperature, event.Data.Humidity)
	}

	fmt.Println("Done. 20 telemetry events published.")
}