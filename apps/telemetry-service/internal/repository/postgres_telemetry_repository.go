// review-sweep
package repository

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
)

type PostgresTelemetryRepository struct {
	db *pgxpool.Pool
}

func NewPostgresTelemetryRepository(db *pgxpool.Pool) *PostgresTelemetryRepository {
	return &PostgresTelemetryRepository{db: db}
}

func (r *PostgresTelemetryRepository) Save(
	ctx context.Context,
	tx pgx.Tx,
	t *domain.Telemetry,
) error {

	_, err := tx.Exec(ctx,
		`INSERT INTO telemetry_readings 
		(id, device_id, temperature, humidity, recorded_at, created_at)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		t.ID,
		t.DeviceID,
		t.Temperature,
		t.Humidity,
		t.RecordedAt,
		t.CreatedAt,
	)

	return err
}