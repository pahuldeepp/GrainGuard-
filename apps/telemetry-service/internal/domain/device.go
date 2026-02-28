package domain

import (
	"time"

	"github.com/google/uuid"
)

type Device struct {
	ID           uuid.UUID
	TenantID     uuid.UUID
	SerialNumber string
	CreatedAt    time.Time
}

func NewDevice(tenantID uuid.UUID, serial string) (*Device, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	return &Device{
		ID:           id,
		TenantID:     tenantID,
		SerialNumber: serial,
		CreatedAt:    time.Now().UTC(),
	}, nil
}
