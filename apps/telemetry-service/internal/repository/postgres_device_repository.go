package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
)

type PostgresDeviceRepository struct {
	db *pgxpool.Pool
}

func NewPostgresDeviceRepository(db *pgxpool.Pool) *PostgresDeviceRepository {
	return &PostgresDeviceRepository{db: db}
}
func (r *PostgresDeviceRepository) Save(ctx context.Context, device *domain.Device) error {
	_, err := r.db.Exec(ctx,
		`INSERT INTO devices (id, tenant_id, serial_number, created_at)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (tenant_id, serial_number)
		 DO NOTHING`,
		device.ID,
		device.TenantID,
		device.SerialNumber,
		device.CreatedAt,
	)
	return err
}

func (r *PostgresDeviceRepository) FindByID(ctx context.Context, id uuid.UUID) (*domain.Device, error) {
	row := r.db.QueryRow(ctx,
		`SELECT id, tenant_id, serial_number, created_at
		 FROM devices WHERE id=$1`, id)

	var d domain.Device
	err := row.Scan(&d.ID, &d.TenantID, &d.SerialNumber, &d.CreatedAt)
	if err != nil {
		return nil, err
	}

	return &d, nil
}
