package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
)

type DeviceRepository interface {
	Save(ctx context.Context, device *domain.Device) error
	FindByID(ctx context.Context, id uuid.UUID) (*domain.Device, error)
}