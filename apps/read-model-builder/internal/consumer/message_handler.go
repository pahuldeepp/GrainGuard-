package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/projection"
)

// jsonEnvelope matches the JSON your transformer actually publishes
type jsonEnvelope struct {
	EventType   string    `json:"eventType"`
	AggregateID string    `json:"aggregateId"`
	OccurredAt  time.Time `json:"occurredAt"`
	Data        struct {
		DeviceID    string  `json:"deviceId"`
		Temperature float64 `json:"temperature"`
		Humidity    float64 `json:"humidity"`
	} `json:"data"`
}

func NewEnvelopeHandler(
	pool *pgxpool.Pool,
	redisClient *redis.Client,
) func(context.Context, []byte) error {

	telemetryHandler := projection.HandleTelemetry(pool, redisClient)

	return func(ctx context.Context, message []byte) error {

		// Parse the JSON envelope your transformer produces
		var env jsonEnvelope
		if err := json.Unmarshal(message, &env); err != nil {
			return fmt.Errorf("invalid json envelope: %w", err)
		}

		switch env.EventType {

		case "telemetry.recorded":

			// Map to the struct projection.HandleTelemetry expects
			deviceID, err := uuid.Parse(env.Data.DeviceID)
			if err != nil {
				return fmt.Errorf("invalid deviceId: %w", err)
			}

			// Re-marshal into the shape HandleTelemetry expects
			normalized, err := json.Marshal(projection.TelemetryEvent{
				ID:          uuid.New(), // generate a stable event ID
				DeviceID:    deviceID,
				Temperature: env.Data.Temperature,
				Humidity:    env.Data.Humidity,
				RecordedAt:  env.OccurredAt.Format(time.RFC3339),
			})
			if err != nil {
				return fmt.Errorf("normalize marshal failed: %w", err)
			}

			return telemetryHandler(normalized)

		default:
			// Unknown event types are skipped, not failed
			return nil
		}
	}
}