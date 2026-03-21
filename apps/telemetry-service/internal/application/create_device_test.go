// review-sweep
package application_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/application"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
)

// ── Mock ─────────────────────────────────────────────────────────────

type mockDeviceRepo struct {
	saveFn    func(ctx context.Context, device *domain.Device) error
	findByIDFn func(ctx context.Context, id uuid.UUID) (*domain.Device, error)
}

func (m *mockDeviceRepo) Save(ctx context.Context, device *domain.Device) error {
	if m.saveFn != nil {
		return m.saveFn(ctx, device)
	}
	return nil
}

func (m *mockDeviceRepo) FindByID(ctx context.Context, id uuid.UUID) (*domain.Device, error) {
	if m.findByIDFn != nil {
		return m.findByIDFn(ctx, id)
	}
	return nil, nil
}

// ── Tests ─────────────────────────────────────────────────────────────

func TestCreateDeviceService_Success(t *testing.T) {
	tenantID := uuid.New().String()
	serial := "SN-0001"
	var saved *domain.Device

	repo := &mockDeviceRepo{
		saveFn: func(_ context.Context, d *domain.Device) error {
			saved = d
			return nil
		},
	}

	svc := application.NewCreateDeviceService(repo)
	device, err := svc.Execute(context.Background(), tenantID, serial)

	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if device == nil {
		t.Fatal("expected device, got nil")
	}
	if device.SerialNumber != serial {
		t.Errorf("serial: want %q got %q", serial, device.SerialNumber)
	}
	if device.TenantID.String() != tenantID {
		t.Errorf("tenantID: want %q got %q", tenantID, device.TenantID.String())
	}
	if saved == nil {
		t.Error("repo.Save was not called")
	}
	if time.Since(device.CreatedAt) > 5*time.Second {
		t.Error("CreatedAt is not recent")
	}
}

func TestCreateDeviceService_InvalidTenantID(t *testing.T) {
	svc := application.NewCreateDeviceService(&mockDeviceRepo{})
	_, err := svc.Execute(context.Background(), "not-a-uuid", "SN-0001")
	if err == nil {
		t.Fatal("expected error for invalid tenantID, got nil")
	}
}

func TestCreateDeviceService_RepoError(t *testing.T) {
	tenantID := uuid.New().String()
	want := errors.New("db connection failed")

	repo := &mockDeviceRepo{
		saveFn: func(_ context.Context, _ *domain.Device) error {
			return want
		},
	}

	svc := application.NewCreateDeviceService(repo)
	_, err := svc.Execute(context.Background(), tenantID, "SN-0001")

	if !errors.Is(err, want) {
		t.Errorf("expected %v, got %v", want, err)
	}
}

// ── domain.NewDevice tests ────────────────────────────────────────────

func TestNewDevice_UniqueIDs(t *testing.T) {
	tenantID := uuid.New()
	d1, _ := domain.NewDevice(tenantID, "SN-001")
	d2, _ := domain.NewDevice(tenantID, "SN-002")
	if d1.ID == d2.ID {
		t.Error("expected unique IDs per device")
	}
}

func TestNewDevice_SetsFields(t *testing.T) {
	tenantID := uuid.New()
	serial := "SN-TEST"
	before := time.Now().UTC().Add(-time.Second)

	device, err := domain.NewDevice(tenantID, serial)

	after := time.Now().UTC().Add(time.Second)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if device.ID == uuid.Nil {
		t.Error("ID should not be nil")
	}
	if device.TenantID != tenantID {
		t.Errorf("TenantID: want %v got %v", tenantID, device.TenantID)
	}
	if device.SerialNumber != serial {
		t.Errorf("SerialNumber: want %q got %q", serial, device.SerialNumber)
	}
	if device.CreatedAt.Before(before) || device.CreatedAt.After(after) {
		t.Errorf("CreatedAt %v not in range [%v, %v]", device.CreatedAt, before, after)
	}
}
