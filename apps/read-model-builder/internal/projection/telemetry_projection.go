package projection

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
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
			// already processed
			return tx.Commit(ctx)
		}

		// Upsert projection
		_, err = tx.Exec(ctx,
			`INSERT INTO device_telemetry_latest
			(device_id, temperature, humidity, recorded_at)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (device_id)
			DO UPDATE SET
			temperature=EXCLUDED.temperature,
			humidity=EXCLUDED.humidity,
			recorded_at=EXCLUDED.recorded_at,
			updated_at=NOW()`,
			event.DeviceID,
			event.Temperature,
			event.Humidity,
			event.RecordedAt,
		)
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

		// Commit DB first (source of truth)
		if err := tx.Commit(ctx); err != nil {
			return err
		}

		// 🔥 Write-through Redis cache AFTER commit
		key := "device:latest:" + event.DeviceID.String()

		cachePayload, _ := json.Marshal(event)

		err = redisClient.Set(ctx, key, cachePayload, 5*time.Minute).Err()
		if err != nil {
			log.Println("Redis write failed:", err)
			// DO NOT return error — Postgres already committed
		}

		return nil
	}
}