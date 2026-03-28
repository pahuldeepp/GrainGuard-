package application

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/repository"
	"github.com/pahuldeepp/grainguard/libs/correlationid"
)

type RecordTelemetryService struct {
	pool          *pgxpool.Pool
	deviceRepo    repository.DeviceRepository
	telemetryRepo repository.TelemetryRepository
	outboxRepo    repository.OutboxRepository
}

type telemetryOutboxEvent struct {
	EventID     string         `json:"eventId"`
	EventType   string         `json:"eventType"`
	AggregateID string         `json:"aggregateId"`
	OccurredAt  string         `json:"occurredAt"`
	Data        map[string]any `json:"data"`
}

func NewRecordTelemetryService(
	pool *pgxpool.Pool,
	deviceRepo repository.DeviceRepository,
	tRepo repository.TelemetryRepository,
	oRepo repository.OutboxRepository,
) *RecordTelemetryService {
	return &RecordTelemetryService{
		pool:          pool,
		deviceRepo:    deviceRepo,
		telemetryRepo: tRepo,
		outboxRepo:    oRepo,
	}
}

func (s *RecordTelemetryService) Execute(
	ctx context.Context,
	deviceID string,
	temp,
	humidity float64,
) error {

	deviceUUID, err := uuid.Parse(deviceID)
	if err != nil {
		return err
	}

	corrID := correlationid.FromContext(ctx)

	// Reject ingest from disabled devices (over-quota tenants)
	device, err := s.deviceRepo.FindByID(ctx, deviceUUID)
	if err != nil {
		return fmt.Errorf("device not found: %w", err)
	}
	if device.Disabled {
		return fmt.Errorf("device %s is disabled: tenant quota exceeded", deviceID)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	telemetry, err := domain.NewTelemetry(deviceUUID, temp, humidity)
	if err != nil {
		return err
	}

	err = s.telemetryRepo.Save(ctx, tx, telemetry)
	if err != nil {
		return err
	}

	payloadBytes, err := json.Marshal(telemetryOutboxEvent{
		EventID:     uuid.NewString(),
		EventType:   "telemetry.recorded",
		AggregateID: deviceID,
		OccurredAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Data: map[string]any{
			"id":          telemetry.ID.String(),
			"deviceId":    telemetry.DeviceID.String(),
			"tenantId":    device.TenantID.String(),
			"temperature": telemetry.Temperature,
			"humidity":    telemetry.Humidity,
			"recordedAt":  telemetry.RecordedAt.Format(time.RFC3339),
		},
	})
	if err != nil {
		return err
	}

	err = s.outboxRepo.Insert(
		ctx,
		tx,
		"telemetry",
		deviceID,
		"telemetry.recorded",
		payloadBytes,
		corrID,
	)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}
