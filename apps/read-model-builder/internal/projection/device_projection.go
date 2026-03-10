package projection

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"
	"encoding/json"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
	"github.com/pahuldeepp/grainguard/libs/observability"
)

func HandleDevice(pool *pgxpool.Pool, redisClient *redis.Client) func([]byte) error {
	return func(payload []byte) error {
		start := time.Now()

		observability.InflightJobs.Inc()
		defer observability.InflightJobs.Dec()

		// Decode Protobuf envelope — same as telemetry handler
		var envelope eventspb.EventEnvelope
		if err := proto.Unmarshal(payload, &envelope); err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		// Only handle device_created_v1
		if envelope.EventType != "device_created_v1" {
			return nil
		}

		if envelope.EventId == "" {
			observability.EventsRetry.Inc()
			return errors.New("missing eventId")
		}

		// Extract DeviceCreatedV1 payload from the oneof
		devicePayload := envelope.GetDeviceCreatedV1()
		if devicePayload == nil {
			observability.EventsRetry.Inc()
			return errors.New("missing DeviceCreatedV1 payload")
		}

		deviceID, err := uuid.Parse(devicePayload.DeviceId)
		if err != nil {
			// Fall back to AggregateId if DeviceId is not a valid UUID
			deviceID, err = uuid.Parse(envelope.AggregateId)
			if err != nil {
				observability.EventsRetry.Inc()
				return err
			}
		}

		tenantID, err := uuid.Parse(envelope.TenantId)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		// Parse created_at from the payload
		createdAt, err := time.Parse(time.RFC3339, devicePayload.CreatedAt)
		if err != nil {
			createdAt = time.Now()
		}

		serialNumber := devicePayload.Serial
		if serialNumber == "" {
			serialNumber = "UNKNOWN"
		}

		ctx := context.Background()

		tx, err := pool.Begin(ctx)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}
		defer tx.Rollback(ctx)

		// Idempotency check
		var inserted string
		err = tx.QueryRow(
			ctx,
			`INSERT INTO processed_events(event_id)
			 VALUES ($1)
			 ON CONFLICT DO NOTHING
			 RETURNING event_id`,
			envelope.EventId,
		).Scan(&inserted)

		if errors.Is(err, pgx.ErrNoRows) {
			observability.EventsProcessed.Inc()
			observability.EventProcessingLatency.Observe(time.Since(start).Seconds())
			return tx.Commit(ctx)
		}

		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		// Upsert into device_projections
		_, err = tx.Exec(
			ctx,
			`INSERT INTO device_projections
			 (device_id, tenant_id, serial_number, created_at)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (device_id) DO NOTHING`,
			deviceID, tenantID, serialNumber, createdAt,
		)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		if err := tx.Commit(ctx); err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		// Cache in Redis with 1 hour TTL
		cachePayload, _ := json.Marshal(map[string]any{
			"device_id":     deviceID.String(),
			"tenant_id":     tenantID.String(),
			"serial_number": serialNumber,
			"created_at":    createdAt.Format(time.RFC3339Nano),
		})

		cacheKey := "device:meta:" + deviceID.String()
		if err := redisClient.Set(ctx, cacheKey, cachePayload, 1*time.Hour).Err(); err != nil {
			log.Println("redis device cache write failed:", err)
		}

		observability.EventsProcessed.Inc()
		observability.EventProcessingLatency.Observe(time.Since(start).Seconds())

		return nil
	}
}