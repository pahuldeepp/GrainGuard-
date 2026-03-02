package application

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/repository"
)
type RecordTelemetryService struct {
	pool          *pgxpool.Pool
	telemetryRepo repository.TelemetryRepository
	outboxRepo    repository.OutboxRepository
}

func NewRecordTelemetryService(
	pool *pgxpool.Pool,
	tRepo repository.TelemetryRepository,
	oRepo repository.OutboxRepository,
) *RecordTelemetryService {
	return &RecordTelemetryService{
		pool:          pool,
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
		TenantId:         "default-tenant",
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
	)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}