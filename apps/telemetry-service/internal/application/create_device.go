package application

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

type txDeviceSaver interface {
	SaveTx(ctx context.Context, tx pgx.Tx, device *domain.Device) error
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

	if s.pool == nil || s.outboxRepo == nil {
		if err = s.repo.Save(ctx, device); err != nil {
			return nil, err
		}
		return device, nil
	}

	txRepo, ok := s.repo.(txDeviceSaver)
	if !ok {
		return nil, errors.New("device repository does not support transactional save")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if rollbackErr := tx.Rollback(rollbackCtx); rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			log.Printf("create device rollback failed: %v", rollbackErr)
		}
	}()

	if saveErr := txRepo.SaveTx(ctx, tx, device); saveErr != nil {
		return nil, saveErr
	}

	payload, err := json.Marshal(map[string]string{
		"device_id":  device.ID.String(),
		"tenant_id":  tenantID,
		"serial":     device.SerialNumber,
		"created_at": device.CreatedAt.Format(time.RFC3339),
	})
	if err != nil {
		return nil, err
	}

	if insertErr := s.outboxRepo.Insert(ctx, tx, "device", device.ID.String(), "device_created_v1", payload, correlationid.FromContext(ctx)); insertErr != nil {
		return nil, insertErr
	}

	if commitErr := tx.Commit(ctx); commitErr != nil {
		return nil, commitErr
	}

	return device, nil
}
