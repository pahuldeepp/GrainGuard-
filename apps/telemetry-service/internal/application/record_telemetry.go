package application
import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

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

	payload, err := json.Marshal(telemetry)
	if err != nil {
		return err
	}

	err = s.outboxRepo.Insert(
		ctx,
		tx,
		"telemetry",
		deviceID,
		"TelemetryRecorded",
		payload,
	)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}
