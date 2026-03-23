package main

import (
	"context"
	"encoding/json"
	"fmt"
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

// initSchema connects to Cassandra without a keyspace, then creates the
// keyspace and tables if they do not already exist.  This eliminates the
// manual cqlsh step that was previously required before first start.
func initSchema(hosts []string, keyspace string) error {
	cluster := gocql.NewCluster(hosts...)
	cluster.Consistency = gocql.One
	cluster.Timeout = 15 * time.Second
	cluster.ConnectTimeout = 30 * time.Second
	cluster.RetryPolicy = &gocql.ExponentialBackoffRetryPolicy{
		NumRetries: 3,
		Min:        200 * time.Millisecond,
		Max:        2 * time.Second,
	}

	var session *gocql.Session
	var err error
	for i := 0; i < 12; i++ {
		session, err = cluster.CreateSession()
		if err == nil {
			break
		}
		log.Printf("[schema] Cassandra not ready for schema init, retrying (%d/12): %v", i+1, err)
		time.Sleep(5 * time.Second)
	}
	if err != nil {
		return fmt.Errorf("schema-init: failed to connect: %w", err)
	}
	defer session.Close()

	stmts := []string{
		// 1. Keyspace
		fmt.Sprintf(`CREATE KEYSPACE IF NOT EXISTS %s
			WITH replication = {'class': 'NetworkTopologyStrategy', 'dc1': 1}
			AND durable_writes = true`, keyspace),

		// 2. Primary time-series table
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s.telemetry_readings (
			tenant_id   uuid,
			device_id   uuid,
			recorded_at timestamp,
			event_id    uuid,
			temperature double,
			humidity    double,
			PRIMARY KEY ((tenant_id, device_id), recorded_at)
		) WITH CLUSTERING ORDER BY (recorded_at DESC)
		  AND default_time_to_live = 7776000
		  AND compaction = {
		    'class': 'TimeWindowCompactionStrategy',
		    'compaction_window_unit': 'DAYS',
		    'compaction_window_size': 1
		  }`, keyspace),

		// 3. Hourly rollup for dashboard charts
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s.telemetry_hourly_rollup (
			tenant_id     uuid,
			device_id     uuid,
			hour_bucket   timestamp,
			avg_temp      double,
			min_temp      double,
			max_temp      double,
			avg_humidity  double,
			reading_count int,
			PRIMARY KEY ((tenant_id, device_id), hour_bucket)
		) WITH CLUSTERING ORDER BY (hour_bucket DESC)
		  AND default_time_to_live = 31536000
		  AND compaction = {
		    'class': 'TimeWindowCompactionStrategy',
		    'compaction_window_unit': 'DAYS',
		    'compaction_window_size': 7
		  }`, keyspace),
	}

	for i, stmt := range stmts {
		if err := session.Query(stmt).Exec(); err != nil {
			return fmt.Errorf("schema-init: statement %d failed: %w", i+1, err)
		}
	}

	log.Printf("[schema] Cassandra schema ready (keyspace=%s)", keyspace)
	return nil
}

func main() {
	kafkaBrokers := getenv("KAFKA_BROKERS", "kafka:9092")
	kafkaTopic := getenv("KAFKA_TOPIC", "telemetry.events")
	kafkaGroup := getenv("KAFKA_GROUP_ID", "cassandra-writer")
	cassandraHosts := getenv("CASSANDRA_HOSTS", "cassandra")
	cassandraKeyspace := getenv("CASSANDRA_KEYSPACE", "grainguard_telemetry")

	// ── Step 1: Initialize schema (idempotent CREATE IF NOT EXISTS) ──────────
	if err := initSchema(strings.Split(cassandraHosts, ","), cassandraKeyspace); err != nil {
		log.Fatalf("Failed to initialize Cassandra schema: %v", err)
	}

	// ── Step 2: Connect with keyspace for data writes ────────────────────────
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

	// ── Step 3: Start Kafka consumer ─────────────────────────────────────────
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
