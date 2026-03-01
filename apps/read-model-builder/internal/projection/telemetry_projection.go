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

		var event TelemetryEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			return err
		}

		ctx := context.Background()

		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		// Idempotency check
		var exists uuid.UUID
		err = tx.QueryRow(ctx,
			`SELECT event_id FROM processed_events WHERE event_id=$1`,
			event.ID,
		).Scan(&exists)

		if err == nil {
			// Duplicate event — already processed
			return tx.Commit(ctx)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			// Real DB error (not just "no row found")
			return err
		}

		// 🔥 Versioned UPSERT
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
			RETURNING version
			`,
			event.DeviceID,
			event.Temperature,
			event.Humidity,
			event.RecordedAt,
		).Scan(&newVersion)

		if err != nil {
			return err
		}

		// Mark event processed
		_, err = tx.Exec(ctx,
			`INSERT INTO processed_events(event_id) VALUES ($1)`,
			event.ID,
		)
		if err != nil {
			return err
		}

		if err := tx.Commit(ctx); err != nil {
			return err
		}

		// 🔥 Versioned Redis Write (after commit)

		versionKey := "device:" + event.DeviceID.String() + ":latest_version"
		dataKey := fmt.Sprintf("device:%s:v%d", event.DeviceID.String(), newVersion)

		cachePayload, _ := json.Marshal(map[string]interface{}{
			"device_id":   event.DeviceID,
			"temperature": event.Temperature,
			"humidity":    event.Humidity,
			"recorded_at": event.RecordedAt,
			"version":     newVersion,
		})

		// Write versioned value
		if err := redisClient.Set(ctx, dataKey, cachePayload, 5*time.Minute).Err(); err != nil {
			log.Println("Redis versioned write failed:", err)
		}

		// Update latest_version pointer
		if err := redisClient.Set(ctx, versionKey, newVersion, 5*time.Minute).Err(); err != nil {
			log.Println("Redis version pointer write failed:", err)
		}

		return nil
	}
}