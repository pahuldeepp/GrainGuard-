package projection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/observability"
)

type TelemetryEvent struct {
	ID          uuid.UUID `json:"ID"`
	DeviceID    uuid.UUID `json:"DeviceID"`
	Temperature float64   `json:"Temperature"`
	Humidity    float64   `json:"Humidity"`
	RecordedAt  string    `json:"RecordedAt"`
}

func HandleTelemetry(pool *pgxpool.Pool, redisClient *redis.Client) func([]byte) error {

	return func(payload []byte) error {

		start := time.Now()

		observability.InflightJobs.Inc()
		defer observability.InflightJobs.Dec()

		var event TelemetryEvent

		if err := json.Unmarshal(payload, &event); err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		recordedAt, err := time.Parse(time.RFC3339, event.RecordedAt)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		ctx := context.Background()

		tx, err := pool.Begin(ctx)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		defer tx.Rollback(ctx)

		var inserted uuid.UUID

		err = tx.QueryRow(ctx,
			`
			INSERT INTO processed_events(event_id)
			VALUES ($1)
			ON CONFLICT DO NOTHING
			RETURNING event_id
			`,
			event.ID,
		).Scan(&inserted)

		if errors.Is(err, pgx.ErrNoRows) {

			observability.EventsProcessed.Inc()

			observability.EventProcessingLatency.Observe(
				time.Since(start).Seconds(),
			)

			return tx.Commit(ctx)
		}

		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		var newVersion int64

		err = tx.QueryRow(ctx,
			`
			INSERT INTO device_telemetry_latest
			(device_id, temperature, humidity, recorded_at, version)
			VALUES ($1,$2,$3,$4,1)
			ON CONFLICT (device_id)
			DO UPDATE SET
				temperature = EXCLUDED.temperature,
				humidity = EXCLUDED.humidity,
				recorded_at = EXCLUDED.recorded_at,
				updated_at = NOW(),
				version = device_telemetry_latest.version + 1
			WHERE EXCLUDED.recorded_at >= device_telemetry_latest.recorded_at
			RETURNING version
			`,
			event.DeviceID,
			event.Temperature,
			event.Humidity,
			recordedAt,
		).Scan(&newVersion)

		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		if err := tx.Commit(ctx); err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		versionKey := "device:" + event.DeviceID.String() + ":latest_version"
		dataKey := fmt.Sprintf("device:%s:v%d", event.DeviceID.String(), newVersion)

		cachePayload, _ := json.Marshal(map[string]interface{}{
			"device_id":   event.DeviceID,
			"temperature": event.Temperature,
			"humidity":    event.Humidity,
			"recorded_at": recordedAt,
			"version":     newVersion,
		})

		pipe := redisClient.Pipeline()

		pipe.Set(ctx, dataKey, cachePayload, 5*time.Minute)
		pipe.Set(ctx, versionKey, newVersion, 5*time.Minute)

		_, err = pipe.Exec(ctx)

		if err != nil {
			log.Println("Redis pipeline write failed:", err)
		}

		observability.EventsProcessed.Inc()

		observability.EventProcessingLatency.Observe(
			time.Since(start).Seconds(),
		)

		return nil
	}
}
