package projection

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
	"github.com/pahuldeepp/grainguard/libs/observability"
)

var errUnsupportedDeviceEvent = errors.New("unsupported device event type")

type deviceEnvelope struct {
	eventID      string
	aggregateID  string
	tenantID     string
	deviceID     string
	serialNumber string
	createdAt    string
}

type legacyDevicePayload struct {
	DeviceID     string `json:"device_id"`
	DeviceIDAlt  string `json:"deviceId"`
	TenantID     string `json:"tenant_id"`
	TenantIDAlt  string `json:"tenantId"`
	Serial       string `json:"serial"`
	SerialNumber string `json:"serial_number"`
	CreatedAt    string `json:"created_at"`
}

type legacyDeviceEnvelope struct {
	EventID          string              `json:"event_id"`
	EventIDAlt       string              `json:"eventId"`
	EventType        string              `json:"event_type"`
	EventTypeAlt     string              `json:"eventType"`
	AggregateID      string              `json:"aggregate_id"`
	AggregateIDAlt   string              `json:"aggregateId"`
	TenantID         string              `json:"tenant_id"`
	TenantIDAlt      string              `json:"tenantId"`
	OccurredAtUnixMs int64               `json:"occurred_at_unix_ms"`
	Payload          legacyDevicePayload `json:"payload"`
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func decodeDeviceEnvelope(payload []byte) (*deviceEnvelope, error) {
	var envelope eventspb.EventEnvelope
	if err := proto.Unmarshal(payload, &envelope); err == nil {
		if envelope.GetEventType() != "device_created_v1" {
			return nil, errUnsupportedDeviceEvent
		}

		devicePayload := envelope.GetDeviceCreatedV1()
		if devicePayload == nil {
			return nil, errors.New("missing DeviceCreatedV1 payload")
		}

		return &deviceEnvelope{
			eventID:      envelope.GetEventId(),
			aggregateID:  envelope.GetAggregateId(),
			tenantID:     firstNonEmpty(envelope.GetTenantId(), devicePayload.GetTenantId()),
			deviceID:     firstNonEmpty(devicePayload.GetDeviceId(), envelope.GetAggregateId()),
			serialNumber: devicePayload.GetSerial(),
			createdAt:    devicePayload.GetCreatedAt(),
		}, nil
	}

	var legacy legacyDeviceEnvelope
	if err := json.Unmarshal(payload, &legacy); err != nil {
		return nil, err
	}

	eventType := firstNonEmpty(legacy.EventType, legacy.EventTypeAlt)
	if eventType != "device_created_v1" {
		return nil, errUnsupportedDeviceEvent
	}

	aggregateID := firstNonEmpty(legacy.AggregateID, legacy.AggregateIDAlt, legacy.Payload.DeviceID, legacy.Payload.DeviceIDAlt)
	deviceID := firstNonEmpty(legacy.Payload.DeviceID, legacy.Payload.DeviceIDAlt, aggregateID)
	tenantID := firstNonEmpty(legacy.TenantID, legacy.TenantIDAlt, legacy.Payload.TenantID, legacy.Payload.TenantIDAlt)
	eventID := firstNonEmpty(legacy.EventID, legacy.EventIDAlt)
	if eventID == "" {
		eventID = aggregateID + ":" + eventType
	}

	return &deviceEnvelope{
		eventID:      eventID,
		aggregateID:  aggregateID,
		tenantID:     tenantID,
		deviceID:     deviceID,
		serialNumber: firstNonEmpty(legacy.Payload.SerialNumber, legacy.Payload.Serial),
		createdAt:    legacy.Payload.CreatedAt,
	}, nil
}

func HandleDevice(pool *pgxpool.Pool, redisClient *redis.Client) func([]byte) error {
	return func(payload []byte) error {
		start := time.Now()

		observability.InflightJobs.Inc()
		defer observability.InflightJobs.Dec()

		envelope, err := decodeDeviceEnvelope(payload)
		if err != nil {
			if errors.Is(err, errUnsupportedDeviceEvent) {
				return nil
			}
			observability.EventsRetry.Inc()
			return err
		}

		if envelope.eventID == "" {
			observability.EventsRetry.Inc()
			return errors.New("missing eventId")
		}

		deviceID, err := uuid.Parse(firstNonEmpty(envelope.deviceID, envelope.aggregateID))
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		tenantID, err := uuid.Parse(envelope.tenantID)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		createdAt, err := time.Parse(time.RFC3339, envelope.createdAt)
		if err != nil {
			createdAt = time.Now().UTC()
		}

		serialNumber := envelope.serialNumber
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

		var inserted string
		err = tx.QueryRow(
			ctx,
			`INSERT INTO processed_events(event_id)
			 VALUES ($1)
			 ON CONFLICT DO NOTHING
			 RETURNING event_id`,
			envelope.eventID,
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

		if redisClient != nil {
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
		}

		observability.EventsProcessed.Inc()
		observability.EventProcessingLatency.Observe(time.Since(start).Seconds())

		return nil
	}
}
