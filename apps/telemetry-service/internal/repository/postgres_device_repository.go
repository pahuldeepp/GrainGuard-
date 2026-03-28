package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
)

type PostgresDeviceRepository struct {
	db *pgxpool.Pool
}

func NewPostgresDeviceRepository(db *pgxpool.Pool) *PostgresDeviceRepository {
	return &PostgresDeviceRepository{db: db}
}

// Save inserts the device. On serial number conflict for the same tenant,
// it returns the existing device's ID by updating device.ID in-place.
func (r *PostgresDeviceRepository) Save(ctx context.Context, device *domain.Device) error {
	return r.saveWithQuerier(ctx, r.db, device)
}

func (r *PostgresDeviceRepository) SaveTx(ctx context.Context, tx pgx.Tx, device *domain.Device) error {
	return r.saveWithQuerier(ctx, tx, device)
}

type deviceQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func (r *PostgresDeviceRepository) saveWithQuerier(
	ctx context.Context,
	q deviceQuerier,
	device *domain.Device,
) error {
	row := q.QueryRow(ctx,
		`INSERT INTO devices (id, tenant_id, serial_number, created_at)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (tenant_id, serial_number)
		 DO UPDATE SET serial_number = EXCLUDED.serial_number
		 RETURNING id`,
		device.ID,
		device.TenantID,
		device.SerialNumber,
		device.CreatedAt,
	)
	return row.Scan(&device.ID)
}

func (r *PostgresDeviceRepository) FindByID(ctx context.Context, id uuid.UUID) (*domain.Device, error) {
	row := r.db.QueryRow(ctx,
		`SELECT id, tenant_id, serial_number, disabled, created_at
		 FROM devices WHERE id=$1`, id)

	var d domain.Device
	err := row.Scan(&d.ID, &d.TenantID, &d.SerialNumber, &d.Disabled, &d.CreatedAt)
	if err != nil {
		return nil, err
	}

	return &d, nil
}
