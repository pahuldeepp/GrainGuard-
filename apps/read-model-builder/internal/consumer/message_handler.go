package consumer

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/projection"
)

// NewEnvelopeHandler returns a single-message handler.
// Used by Start() for backwards compatibility.
func NewEnvelopeHandler(
	pool *pgxpool.Pool,
	redisClient *redis.Client,
) func(context.Context, []byte) error {
	telemetryHandler := projection.HandleTelemetry(pool, redisClient)
	return func(ctx context.Context, message []byte) error {
		return telemetryHandler(message)
	}
}

// NewBatchEnvelopeHandler returns a batch handler.
// Used by StartBatch() for high-throughput processing.
// Processes up to 64 events in a single DB transaction + Redis pipeline.
func NewBatchEnvelopeHandler(
	pool *pgxpool.Pool,
	redisClient *redis.Client,
) func(context.Context, [][]byte) error {
	return projection.HandleTelemetryBatch(pool, redisClient)
}