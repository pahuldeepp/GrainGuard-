package consumer

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/projection"
	"github.com/redis/go-redis/v9"
)

func NewEnvelopeHandler(
	pool *pgxpool.Pool,
	redisClient *redis.Client,
) func(context.Context, []byte) error {
	deviceHandler := projection.HandleDevice(pool, redisClient)

	return func(ctx context.Context, message []byte) error {
		return deviceHandler(message)
	}
}

func NewBatchEnvelopeHandler(
	pool *pgxpool.Pool,
	redisClient *redis.Client,
) func(context.Context, [][]byte) error {
	return projection.HandleTelemetryBatch(pool, redisClient)
}
