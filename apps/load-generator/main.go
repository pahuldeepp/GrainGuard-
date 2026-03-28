package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

type TelemetryEvent struct {
	EventID     string    `json:"eventId"`
	EventType   string    `json:"eventType"`
	AggregateID string    `json:"aggregateId"`
	OccurredAt  time.Time `json:"occurredAt"`
	Data        struct {
		DeviceID    string    `json:"deviceId"`
		TenantID    string    `json:"tenantId"`
		RecordedAt  time.Time `json:"recordedAt"`
		Temperature float64   `json:"temperature"`
		Humidity    float64   `json:"humidity"`
	} `json:"data"`
}

func main() {

	brokers := getenv("KAFKA_BROKERS", "localhost:9093")
	topic := getenv("TOPIC", "telemetry.events")
	workers, _ := strconv.Atoi(getenv("WORKERS", "10"))
	ratePerSec, _ := strconv.Atoi(getenv("RATE", "1000"))
	durationSec, _ := strconv.Atoi(getenv("DURATION", "30"))

	tenantID := getenv("TENANT_ID", "11111111-1111-1111-1111-111111111111")

	// Use real device IDs
	deviceIDs := os.Getenv("DEVICE_IDS")

	var devices []string
	if deviceIDs != "" {
		devices = strings.Split(deviceIDs, ",")
		for i := range devices {
			devices[i] = strings.TrimSpace(devices[i])
		}
	} else {
		deviceCount := 100
		devices = make([]string, deviceCount)
		for i := range devices {
			devices[i] = uuid.New().String()
		}
	}

	deviceCount := len(devices)

	writer := &kafka.Writer{
		Addr:                   kafka.TCP(brokers),
		Topic:                  topic,
		Balancer:               &kafka.LeastBytes{},
		BatchSize:              500,
		BatchTimeout:           5 * time.Millisecond,
		RequiredAcks:           kafka.RequireOne,
		AllowAutoTopicCreation: true,
	}
	defer writer.Close() //nolint:errcheck

	ctx, cancel := context.WithTimeout(
		//nolint:gosec // Load generation is driven by a standalone process-scoped context.
		context.Background(),
		time.Duration(durationSec)*time.Second,
	)
	defer cancel()

	var sent atomic.Int64
	var errors atomic.Int64

	interval := time.Second / time.Duration(ratePerSec)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	go func() {
		prev := int64(0)
		for {
			time.Sleep(1 * time.Second)
			current := sent.Load()
			errs := errors.Load()
			fmt.Printf("✅ sent=%d rate=%d/s errors=%d\n", current, current-prev, errs)
			prev = current
		}
	}()

	msgCh := make(chan kafka.Message, workers*100)

	var wg sync.WaitGroup

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for msg := range msgCh {
				if err := writer.WriteMessages(ctx, msg); err != nil {
					errors.Add(1)
				} else {
					sent.Add(1)
				}
			}
		}()
	}

	log.Printf("🚀 Starting load: %d events/sec for %ds\n", ratePerSec, durationSec)

	i := 0
	for {
		select {
		case <-ctx.Done():
			close(msgCh)
			wg.Wait()
			fmt.Printf("🏁 Done. sent=%d errors=%d\n", sent.Load(), errors.Load())
			return

		case <-ticker.C:

			deviceID := devices[i%deviceCount]

			evt := TelemetryEvent{
				EventID:     uuid.New().String(),
				EventType:   "telemetry.recorded",
				AggregateID: deviceID,
				OccurredAt:  time.Now().UTC(),
			}

			evt.Data.DeviceID = deviceID
			evt.Data.TenantID = tenantID
			evt.Data.Temperature = 20 + float64(i%10)
			evt.Data.RecordedAt = time.Now().UTC()
			evt.Data.Humidity = 40 + float64(i%10)

			b, _ := json.Marshal(evt)

			msgCh <- kafka.Message{
				Key:   []byte(deviceID),
				Value: b,
			}

			i++
		}
	}
}

func getenv(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}
