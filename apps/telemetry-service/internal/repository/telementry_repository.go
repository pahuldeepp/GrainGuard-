package repository

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/domain"
)

type TelemetryRepository interface {
	Save(ctx context.Context, tx pgx.Tx, telemetry *domain.Telemetry) error
}

