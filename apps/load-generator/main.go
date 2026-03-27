package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

// Matches exactly what your cdc-transformer publishes
type TelemetryEvent struct {
	EventType   string    `json:"eventType"`
	AggregateID string    `json:"aggregateId"`
	OccurredAt  time.Time `json:"occurredAt"`
	Data        struct {
		DeviceID    string  `json:"deviceId"`
		Temperature float64 `json:"temperature"`
		Humidity    float64 `json:"humidity"`
	} `json:"data"`
}

func main() {
	brokers := getenv("KAFKA_BROKERS", "localhost:9093")
	topic := getenv("TOPIC", "telemetry.events")
	workers, _ := strconv.Atoi(getenv("WORKERS", "10"))
	ratePerSec, _ := strconv.Atoi(getenv("RATE", "1000"))
	durationSec, _ := strconv.Atoi(getenv("DURATION", "30"))

	// Pre-generate a pool of device IDs to simulate real devices
	deviceCount := 100
	devices := make([]string, deviceCount)
	for i := range devices {
		devices[i] = uuid.New().String()
	}

	writer := &kafka.Writer{
		Addr:                   kafka.TCP(brokers),
		Topic:                  topic,
		Balancer:               &kafka.LeastBytes{},
		BatchSize:              500,
		BatchTimeout:           5 * time.Millisecond,
		RequiredAcks:           kafka.RequireOne,
		AllowAutoTopicCreation: true,
	}
	defer writer.Close()

	ctx, cancel := context.WithTimeout(
		context.Background(),
		time.Duration(durationSec)*time.Second,
	)
	defer cancel()

	var (
		sent   atomic.Int64
		errors atomic.Int64
	)

	// Ticker controls rate
	interval := time.Second / time.Duration(ratePerSec)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Stats printer
	go func() {
		prev := int64(0)
		for {
			time.Sleep(1 * time.Second)
			current := sent.Load()
			errs := errors.Load()
			fmt.Printf(
				"✅ sent=%-8d  rate=%-6d/s  errors=%d\n",
				current, current-prev, errs,
			)
			prev = current
		}
	}()

	// Worker pool
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

	// Feed messages at the target rate
	log.Printf("🚀 Starting load: %d events/sec for %ds with %d workers\n",
		ratePerSec, durationSec, workers)

	i := 0
	for {
		select {
		case <-ctx.Done():
			close(msgCh)
			wg.Wait()
			fmt.Printf("\n🏁 Done. Total sent: %d, errors: %d\n",
				sent.Load(), errors.Load())
			os.Exit(0)

		case <-ticker.C:
			deviceID := devices[i%deviceCount]
			evt := TelemetryEvent{
				EventType:   "telemetry.recorded",
				AggregateID: deviceID,
				OccurredAt:  time.Now().UTC(),
			}
			evt.Data.DeviceID = deviceID
			evt.Data.Temperature = 20.0 + float64(i%20)
			evt.Data.Humidity = 40.0 + float64(i%30)

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
