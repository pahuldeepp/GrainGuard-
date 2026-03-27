package application

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"

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
	defer tx.Rollback(ctx)

	telemetry, err := domain.NewTelemetry(deviceUUID, temp, humidity)
	if err != nil {
		return err
	}

	err = s.telemetryRepo.Save(ctx, tx, telemetry)
	if err != nil {
		return err
	}

	// 🔥 Build protobuf envelope
	env := &eventspb.EventEnvelope{
		EventId:          uuid.NewString(),
		EventType:        "telemetry.recorded",
		SchemaVersion:    1,
		OccurredAtUnixMs: time.Now().UTC().UnixMilli(),
		TenantId:         device.TenantID.String(),
		AggregateId:      deviceID,
		Payload: &eventspb.EventEnvelope_TelemetryRecordedV1{
			TelemetryRecordedV1: &eventspb.TelemetryRecordedV1{
				Id:          telemetry.ID.String(),
				DeviceId:    telemetry.DeviceID.String(),
				Temperature: telemetry.Temperature,
				Humidity:    telemetry.Humidity,
				RecordedAt:  telemetry.RecordedAt.Format(time.RFC3339),
			},
		},
	}

	// 🔥 Marshal protobuf
	payloadBytes, err := proto.Marshal(env)
	if err != nil {
		return err
	}

	// 🔥 Insert protobuf bytes into outbox
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
