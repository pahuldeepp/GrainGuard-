package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gocql/gocql"
	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

type TelemetryEvent struct {
	EventID     string `json:"eventId"`
	EventType   string `json:"eventType"`
	AggregateID string `json:"aggregateId"`
	OccurredAt  string `json:"occurredAt"`
	Data        struct {
		DeviceID    string   `json:"deviceId"`
		TenantID    string   `json:"tenantId"`
		Temperature *float64 `json:"temperature"`
		Humidity    *float64 `json:"humidity"`
	} `json:"data"`
}

type parsedEvent struct {
	msg        kafka.Message
	tenantID   gocql.UUID
	deviceID   gocql.UUID
	eventID    gocql.UUID
	recordedAt time.Time
	temp       float64
	humidity   float64
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
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

const insertCQL = `INSERT INTO telemetry_readings
	(tenant_id, device_id, recorded_at, event_id, temperature, humidity)
	VALUES (?, ?, ?, ?, ?, ?)
	USING TTL 7776000`

func main() {
	kafkaBrokers := getenv("KAFKA_BROKERS", "kafka:9092")
	kafkaTopic := getenv("KAFKA_TOPIC", "telemetry.events")
	kafkaGroup := getenv("KAFKA_GROUP_ID", "cassandra-writer")
	cassandraHosts := getenv("CASSANDRA_HOSTS", "cassandra")
	cassandraKeyspace := getenv("CASSANDRA_KEYSPACE", "grainguard_telemetry")

	workerCount := getenvInt("WORKER_COUNT", runtime.NumCPU()*4)
	batchSize := getenvInt("BATCH_SIZE", 100)
	channelSize := getenvInt("CHANNEL_SIZE", 8192)
	batchTimeout := time.Duration(getenvInt("BATCH_TIMEOUT_MS", 50)) * time.Millisecond

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
	cluster.NumConns = workerCount // one conn per worker
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
	defer reader.Close() //nolint:errcheck
	log.Printf("Kafka consumer started topic=%s group=%s workers=%d batchSize=%d",
		kafkaTopic, kafkaGroup, workerCount, batchSize)

	// Graceful shutdown
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// ── Step 4: Worker pool with batch writes ────────────────────────────────
	jobs := make(chan parsedEvent, channelSize)

	var processed atomic.Int64
	var skipped atomic.Int64
	var batches atomic.Int64
	var wg sync.WaitGroup

	// Launch workers — each accumulates events and flushes as unlogged batches
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()

			batch := make([]parsedEvent, 0, batchSize)
			timer := time.NewTimer(batchTimeout)
			defer timer.Stop()

			flush := func() {
				if len(batch) == 0 {
					return
				}

				// Use unlogged batch — no coordinator overhead, ideal for time-series
				cqlBatch := session.NewBatch(gocql.UnloggedBatch)
				msgs := make([]kafka.Message, 0, len(batch))

				for _, evt := range batch {
					cqlBatch.Query(insertCQL,
						evt.tenantID, evt.deviceID, evt.recordedAt,
						evt.eventID, evt.temp, evt.humidity,
					)
					msgs = append(msgs, evt.msg)
				}

				if err := session.ExecuteBatch(cqlBatch); err != nil {
					log.Printf("[worker-%d] batch write error (%d events): %v", workerID, len(batch), err)
					// Don't commit — messages will be redelivered
					batch = batch[:0]
					return
				}

				// Commit all messages in one call
				if err := reader.CommitMessages(ctx, msgs...); err != nil {
					log.Printf("[worker-%d] commit error: %v", workerID, err)
				}

				processed.Add(int64(len(batch)))
				batches.Add(1)
				batch = batch[:0]
			}

			for {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(batchTimeout)

			accumulate:
				for len(batch) < batchSize {
					select {
					case evt, ok := <-jobs:
						if !ok {
							flush()
							return
						}
						batch = append(batch, evt)
					case <-timer.C:
						break accumulate
					case <-ctx.Done():
						flush()
						return
					}
				}

				flush()
			}
		}(i)
	}

	// ── Step 5: Fetch loop — parse and dispatch to workers ───────────────────
	go func() {
		for {
			msg, err := reader.FetchMessage(ctx)
			if err != nil {
				if ctx.Err() != nil {
					break
				}
				log.Printf("Kafka fetch error: %v", err)
				continue
			}

			var event TelemetryEvent
			if unmarshalErr := json.Unmarshal(msg.Value, &event); unmarshalErr != nil {
				log.Printf("Unmarshal error: %v", unmarshalErr)
				if commitErr := reader.CommitMessages(ctx, msg); commitErr != nil {
					log.Printf("commit error after unmarshal failure: %v", commitErr)
				}
				skipped.Add(1)
				continue
			}

			// Validate required fields
			if event.EventID == "" || event.Data.TenantID == "" || event.Data.DeviceID == "" {
				skipped.Add(1)
				if commitErr := reader.CommitMessages(ctx, msg); commitErr != nil {
					log.Printf("commit error after validation failure: %v", commitErr)
				}
				continue
			}

			if event.EventType != "telemetry.recorded" {
				skipped.Add(1)
				if commitErr := reader.CommitMessages(ctx, msg); commitErr != nil {
					log.Printf("commit error after skipping event type: %v", commitErr)
				}
				continue
			}

			// Parse IDs
			tenantID, err := gocql.ParseUUID(event.Data.TenantID)
			if err != nil {
				skipped.Add(1)
				if commitErr := reader.CommitMessages(ctx, msg); commitErr != nil {
					log.Printf("commit error after tenant parse failure: %v", commitErr)
				}
				continue
			}

			deviceID, err := gocql.ParseUUID(event.Data.DeviceID)
			if err != nil {
				skipped.Add(1)
				if commitErr := reader.CommitMessages(ctx, msg); commitErr != nil {
					log.Printf("commit error after device parse failure: %v", commitErr)
				}
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

			parsed := parsedEvent{
				msg:        msg,
				tenantID:   tenantID,
				deviceID:   deviceID,
				eventID:    eventID,
				recordedAt: recordedAt,
				temp:       temp,
				humidity:   humidity,
			}

			select {
			case jobs <- parsed:
			case <-ctx.Done():
				return
			}
		}

		close(jobs)
	}()

	// ── Stats ticker ─────────────────────────────────────────────────────────
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				log.Printf("cassandra-writer processed=%d skipped=%d batches=%d workers=%d",
					processed.Load(), skipped.Load(), batches.Load(), workerCount)
			case <-ctx.Done():
				return
			}
		}
	}()

	<-ctx.Done()
	log.Println("Shutting down — draining workers...")
	wg.Wait()
	log.Printf("cassandra-writer stopped. total_processed=%d total_skipped=%d total_batches=%d",
		processed.Load(), skipped.Load(), batches.Load())
}

func init() {
	// Ensure uuid package is used
	_ = uuid.New()
}
