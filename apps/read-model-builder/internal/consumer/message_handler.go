package consumer

import (
	"encoding/json"
	"fmt"

	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/projection"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func NewEnvelopeHandler(
	pool *pgxpool.Pool,
	redisClient *redis.Client,
) func([]byte) error {

	// existing projection function
	telemetryHandler := projection.HandleTelemetry(pool, redisClient)

	return func(message []byte) error {

		// 🔥 Unmarshal protobuf envelope
		var env eventspb.EventEnvelope
		if err := proto.Unmarshal(message, &env); err != nil {
			return fmt.Errorf("invalid protobuf envelope: %w", err)
		}

		if env.SchemaVersion != 1 {
			return fmt.Errorf("unsupported schema version: %d", env.SchemaVersion)
		}

		switch p := env.Payload.(type) {

		case *eventspb.EventEnvelope_TelemetryRecordedV1:

			// Convert proto payload → JSON to reuse existing projection
			jsonPayload, err := json.Marshal(p.TelemetryRecordedV1)
			if err != nil {
				return fmt.Errorf("proto to json marshal failed: %w", err)
			}

			return telemetryHandler(jsonPayload)

		default:
			return fmt.Errorf("unknown payload type: %T", p)
		}
	}
}