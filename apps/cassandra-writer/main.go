package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"
	"time"

	"github.com/gocql/gocql"
	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

type TelemetryEvent struct {
	EventID     string    `json:"eventId"`
	EventType   string    `json:"eventType"`
	AggregateID string    `json:"aggregateId"`
	OccurredAt  string    `json:"occurredAt"`
	Data        struct {
		DeviceID    string   `json:"deviceId"`
		TenantID    string   `json:"tenantId"`
		Temperature *float64 `json:"temperature"`
		Humidity    *float64 `json:"humidity"`
	} `json:"data"`
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	kafkaBrokers := getenv("KAFKA_BROKERS", "kafka:9092")
	kafkaTopic := getenv("KAFKA_TOPIC", "telemetry.events")
	kafkaGroup := getenv("KAFKA_GROUP_ID", "cassandra-writer")
	cassandraHosts := getenv("CASSANDRA_HOSTS", "cassandra")
	cassandraKeyspace := getenv("CASSANDRA_KEYSPACE", "grainguard_telemetry")

	// Connect to Cassandra
	cluster := gocql.NewCluster(strings.Split(cassandraHosts, ",")...)
	cluster.Keyspace = cassandraKeyspace
	cluster.Consistency = gocql.LocalQuorum
	cluster.Timeout = 10 * time.Second
	cluster.ConnectTimeout = 30 * time.Second
	cluster.RetryPolicy = &gocql.ExponentialBackoffRetryPolicy{
		NumRetries: 3,
		Min:        100 * time.Millisecond,
		Max:        2 * time.Second,
	}

	var session *gocql.Session
	var err error
	for i := 0; i < 10; i++ {
		session, err = cluster.CreateSession()
		if err == nil {
			break
		}
		log.Printf("Cassandra not ready, retrying in 5s (%d/10): %v", i+1, err)
		time.Sleep(5 * time.Second)
	}
	if err != nil {
		log.Fatalf("Failed to connect to Cassandra: %v", err)
	}
	defer session.Close()
	log.Printf("Connected to Cassandra keyspace=%s", cassandraKeyspace)

	// Connect to Kafka
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     strings.Split(kafkaBrokers, ","),
		Topic:       kafkaTopic,
		GroupID:     kafkaGroup,
		MinBytes:    10e3,
		MaxBytes:    10e6,
		MaxWait:     500 * time.Millisecond,
		StartOffset: kafka.LastOffset,
	})
	defer reader.Close()
	log.Printf("Kafka consumer started topic=%s group=%s", kafkaTopic, kafkaGroup)

	const insertCQL = `
		INSERT INTO telemetry_readings 
		(tenant_id, device_id, recorded_at, event_id, temperature, humidity)
		VALUES (?, ?, ?, ?, ?, ?)
		USING TTL 7776000`

	ctx := context.Background()
	processed := 0
	skipped := 0

	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			log.Printf("Kafka fetch error: %v", err)
			continue
		}

		var event TelemetryEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("Unmarshal error: %v", err)
			reader.CommitMessages(ctx, msg)
			skipped++
			continue
		}

		// Validate required fields
		if event.EventID == "" || event.Data.TenantID == "" || event.Data.DeviceID == "" {
			skipped++
			reader.CommitMessages(ctx, msg)
			continue
		}

		if event.EventType != "telemetry.recorded" {
			reader.CommitMessages(ctx, msg)
			continue
		}

		// Parse IDs
		tenantID, err := gocql.ParseUUID(event.Data.TenantID)
		if err != nil {
			skipped++
			reader.CommitMessages(ctx, msg)
			continue
		}

		deviceID, err := gocql.ParseUUID(event.Data.DeviceID)
		if err != nil {
			skipped++
			reader.CommitMessages(ctx, msg)
			continue
		}

		eventID, err := gocql.ParseUUID(event.EventID)
		if err != nil {
			eventID = gocql.UUIDFromTime(time.Now())
		}

		// Parse timestamp
		recordedAt, err := time.Parse(time.RFC3339Nano, event.OccurredAt)
		if err != nil {
			recordedAt, err = time.Parse(time.RFC3339, event.OccurredAt)
			if err != nil {
				recordedAt = time.Now().UTC()
			}
		}

		var temp, humidity float64
		if event.Data.Temperature != nil {
			temp = *event.Data.Temperature
		}
		if event.Data.Humidity != nil {
			humidity = *event.Data.Humidity
		}

		// Write to Cassandra
		if err := session.Query(insertCQL,
			tenantID, deviceID, recordedAt, eventID, temp, humidity,
		).Exec(); err != nil {
			log.Printf("Cassandra write error: %v", err)
			continue
		}

		reader.CommitMessages(ctx, msg)
		processed++

		if processed%100 == 0 {
			log.Printf("cassandra-writer processed=%d skipped=%d", processed, skipped)
		}
	}
}

func init() {
	// Ensure uuid package is used
	_ = uuid.New()
}

