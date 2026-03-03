package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/domain"
)

type PostgresSagaRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresSagaRepository(pool *pgxpool.Pool) *PostgresSagaRepository {
	return &PostgresSagaRepository{pool: pool}
}

func (r *PostgresSagaRepository) Create(ctx context.Context, saga *domain.Saga) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO sagas (saga_id, saga_type, correlation_id, status, current_step, payload, last_error)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
	`, saga.ID, string(saga.Type), saga.CorrelationID, string(saga.Status), saga.CurrentStep, saga.PayloadJSON, saga.LastError)
	return err
}

func (r *PostgresSagaRepository) FindByCorrelationID(ctx context.Context, correlationID string) (*domain.Saga, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT saga_id, saga_type, correlation_id, status, current_step, payload, COALESCE(last_error,'')
		FROM sagas
		WHERE correlation_id = $1
	`, correlationID)

	var s domain.Saga
	var id uuid.UUID
	var sagaType string
	var status string

	if err := row.Scan(&id, &sagaType, &s.CorrelationID, &status, &s.CurrentStep, &s.PayloadJSON, &s.LastError); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, pgx.ErrNoRows
		}
		return nil, err
	}

	s.ID = id
	s.Type = domain.SagaType(sagaType)
	s.Status = domain.SagaStatus(status)
	return &s, nil
}

func (r *PostgresSagaRepository) UpdateStepStatus(ctx context.Context, sagaID string, step string, status string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE sagas
		SET current_step = $2,
		    status = $3,
		    updated_at = NOW()
		WHERE saga_id = $1
	`, sagaID, step, status)
	return err
}

func (r *PostgresSagaRepository) MarkFailed(ctx context.Context, sagaID string, errMsg string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE sagas
		SET status = $2,
		    last_error = $3,
		    updated_at = NOW()
		WHERE saga_id = $1
	`, sagaID, string(domain.StatusFailed), errMsg)
	return err
}