package domain

import (
	"time"

	"github.com/google/uuid"
)

type Telemetry struct {
	ID          uuid.UUID
	DeviceID    uuid.UUID
	Temperature float64
	Humidity    float64
	RecordedAt  time.Time
	CreatedAt   time.Time
}

func NewTelemetry(deviceID uuid.UUID, temp, humidity float64) (*Telemetry, error) {

	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	

	return &Telemetry{
		ID:          id,
		DeviceID:    deviceID,
		Temperature: temp,
		Humidity:    humidity,
		RecordedAt:  time.Now().UTC(),
		CreatedAt:   time.Now().UTC(),
	}, nil
}

