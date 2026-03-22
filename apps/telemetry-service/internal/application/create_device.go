package application

import (
	"context"

	"github.com/google/uuid"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/repository"
)


type CreateDeviceService struct {
	repo repository.DeviceRepository
}


func NewCreateDeviceService(repo repository.DeviceRepository) *CreateDeviceService {
	return &CreateDeviceService{repo: repo}
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

	err = s.repo.Save(ctx, device)
	if err != nil {
		return nil, err
	}

	return device, nil
}

