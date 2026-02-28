package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresOutboxRepository struct {
	db *pgxpool.Pool
}

func NewPostgresOutboxRepository(db *pgxpool.Pool) *PostgresOutboxRepository {
	return &PostgresOutboxRepository{}
}

func (r *PostgresOutboxRepository) Insert(
	ctx context.Context,
	tx pgx.Tx,
	aggregateType,
	aggregateID,
	eventType string,
	payload []byte,
) error {

	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO outbox_events
		(id, aggregate_type, aggregate_id, event_type, payload)
		VALUES ($1,$2,$3,$4,$5)`,
		id,
		aggregateType,
		aggregateID,
		eventType,
		payload,
	)
	return err
}

