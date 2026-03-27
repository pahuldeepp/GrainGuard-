package application

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/repository"
	"github.com/pahuldeepp/grainguard/libs/correlationid"
)

type CreateDeviceService struct {
	pool       *pgxpool.Pool
	repo       repository.DeviceRepository
	outboxRepo repository.OutboxRepository
}

func NewCreateDeviceService(pool *pgxpool.Pool, repo repository.DeviceRepository, outboxRepo repository.OutboxRepository) *CreateDeviceService {
	return &CreateDeviceService{pool: pool, repo: repo, outboxRepo: outboxRepo}
}

func (s *CreateDeviceService) Execute(ctx context.Context, tenantID string, serial string) (*domain.Device, error) {
	tenantUUID, err := uuid.Parse(tenantID)
	if err != nil {
		return nil, err
	}

	device, err := domain.NewDevice(tenantUUID, serial)
	if err != nil {
		return nil, err
	}

	// Save the device (uses the pool directly, not a tx)
	if err = s.repo.Save(ctx, device); err != nil {
		return nil, err
	}

	// Write outbox event in its own transaction so the read-model-builder
	// can upsert device_projections on the read DB.
	if s.pool == nil || s.outboxRepo == nil {
		return device, nil
	}

	payload, _ := json.Marshal(map[string]string{
		"device_id":  device.ID.String(),
		"tenant_id":  tenantID,
		"serial":     device.SerialNumber,
		"created_at": device.CreatedAt.Format(time.RFC3339),
	})

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if err = s.outboxRepo.Insert(ctx, tx, "device", device.ID.String(), "device_created_v1", payload, correlationid.FromContext(ctx)); err != nil {
		return nil, err
	}

	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}

	return device, nil
}
