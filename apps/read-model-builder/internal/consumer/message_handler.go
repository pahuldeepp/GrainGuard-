package consumer

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/projection"
)

func NewEnvelopeHandler(
	pool *pgxpool.Pool,
	redisClient *redis.Client,
) func(context.Context, []byte) error {
	telemetryHandler := projection.HandleTelemetry(pool, redisClient)
	deviceHandler := projection.HandleDevice(pool, redisClient)

	return func(ctx context.Context, message []byte) error {

		// Decode just enough to get the event type
		// Then pass raw bytes to the correct handler
		var envelope eventspb.EventEnvelope
		if err := proto.Unmarshal(message, &envelope); err != nil {
			return err
		}

		switch envelope.EventType {
		case "telemetry.recorded":
			return telemetryHandler(message)
		case "device_created_v1":
			return deviceHandler(message)
		default:
			return nil
		}
	}
}

func NewBatchEnvelopeHandler(
	pool *pgxpool.Pool,
	redisClient *redis.Client,
) func(context.Context, [][]byte) error {
	return projection.HandleTelemetryBatch(pool, redisClient)
}