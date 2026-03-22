package domain_test

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
)

func TestNewTelemetry_SetsFields(t *testing.T) {
	deviceID := uuid.New()
	temp := 24.5
	humidity := 65.0
	before := time.Now().UTC().Add(-time.Second)

	tel, err := domain.NewTelemetry(deviceID, temp, humidity)

	after := time.Now().UTC().Add(time.Second)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tel.ID == uuid.Nil {
		t.Error("ID should not be nil")
	}
	if tel.DeviceID != deviceID {
		t.Errorf("DeviceID: want %v got %v", deviceID, tel.DeviceID)
	}
	if tel.Temperature != temp {
		t.Errorf("Temperature: want %v got %v", temp, tel.Temperature)
	}
	if tel.Humidity != humidity {
		t.Errorf("Humidity: want %v got %v", humidity, tel.Humidity)
	}
	if tel.RecordedAt.Before(before) || tel.RecordedAt.After(after) {
		t.Errorf("RecordedAt %v not in range", tel.RecordedAt)
	}
}

func TestNewTelemetry_UniqueIDs(t *testing.T) {
	deviceID := uuid.New()
	t1, _ := domain.NewTelemetry(deviceID, 20.0, 50.0)
	t2, _ := domain.NewTelemetry(deviceID, 21.0, 51.0)

	if t1.ID == t2.ID {
		t.Error("expected unique IDs per telemetry reading")
	}
}

func TestNewTelemetry_ExtremeValues(t *testing.T) {
	deviceID := uuid.New()

	tests := []struct {
		name     string
		temp     float64
		humidity float64
	}{
		{"zero values", 0.0, 0.0},
		{"negative temp", -40.0, 10.0},
		{"high temp", 100.0, 100.0},
		{"max float", 1e10, 1e10},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tel, err := domain.NewTelemetry(deviceID, tt.temp, tt.humidity)
			if err != nil {
				t.Fatalf("unexpected error for %s: %v", tt.name, err)
			}
			if tel.Temperature != tt.temp {
				t.Errorf("Temperature: want %v got %v", tt.temp, tel.Temperature)
			}
			if tel.Humidity != tt.humidity {
				t.Errorf("Humidity: want %v got %v", tt.humidity, tel.Humidity)
			}
		})
	}
}

func TestNewTelemetry_SameDeviceDifferentReadings(t *testing.T) {
	deviceID := uuid.New()
	readings := []struct{ temp, humidity float64 }{
		{20.0, 50.0},
		{25.0, 60.0},
		{30.0, 70.0},
	}

	ids := make(map[uuid.UUID]bool)
	for _, r := range readings {
		tel, err := domain.NewTelemetry(deviceID, r.temp, r.humidity)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if ids[tel.ID] {
			t.Errorf("duplicate ID %v", tel.ID)
		}
		ids[tel.ID] = true
		if tel.DeviceID != deviceID {
			t.Errorf("DeviceID should be consistent")
		}
	}
}

