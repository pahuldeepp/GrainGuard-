package repository

import (
    "context"
    "errors"
    "time"

    "github.com/google/uuid"
    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"

    "github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/domain"
)

const dbQueryTimeout = 10 * time.Second

// withTimeout wraps a context with a query timeout if one isn't already set.
func withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
    if _, ok := ctx.Deadline(); ok {
        return ctx, func() {} // caller already set a deadline
    }
    return context.WithTimeout(ctx, dbQueryTimeout)
}

type PostgresSagaRepository struct {
    pool *pgxpool.Pool
}

func NewPostgresSagaRepository(pool *pgxpool.Pool) *PostgresSagaRepository {
    return &PostgresSagaRepository{pool: pool}
}

func (r *PostgresSagaRepository) Create(ctx context.Context, saga *domain.Saga) error {
    ctx, cancel := withTimeout(ctx)
    defer cancel()
    _, err := r.pool.Exec(ctx, `
        INSERT INTO sagas (saga_id, saga_type, correlation_id, status, current_step, payload, last_error)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, saga.ID, string(saga.Type), saga.CorrelationID, string(saga.Status), saga.CurrentStep, saga.PayloadJSON, saga.LastError)
    return err
}

// FindByCorrelationID looks up a saga by its correlation ID (device UUID).
// Note: correlation_id is a globally unique UUID, so cross-tenant collision is not possible.
// The payload JSON contains tenant_id for auditing. If tenant_id column is added to the
// sagas table in the future, add a WHERE tenant_id = $2 filter here for defense in depth.
func (r *PostgresSagaRepository) FindByCorrelationID(ctx context.Context, correlationID string) (*domain.Saga, error) {
    ctx, cancel := withTimeout(ctx)
    defer cancel()
    row := r.pool.QueryRow(ctx, `
        SELECT saga_id, saga_type, correlation_id, status, current_step, payload, COALESCE(last_error,'')
        FROM sagas
        WHERE correlation_id = $1
        ORDER BY created_at DESC
        LIMIT 1
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
    ctx, cancel := withTimeout(ctx)
    defer cancel()
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
    ctx, cancel := withTimeout(ctx)
    defer cancel()
    _, err := r.pool.Exec(ctx, `
        UPDATE sagas
        SET status = $2,
            last_error = $3,
            updated_at = NOW()
        WHERE saga_id = $1
    `, sagaID, string(domain.StatusFailed), errMsg)
    return err
}

// IsEventProcessed returns true if this event_id was already handled
func (r *PostgresSagaRepository) IsEventProcessed(ctx context.Context, eventID string) (bool, error) {
    var exists bool
    err := r.pool.QueryRow(ctx, `
        SELECT EXISTS(SELECT 1 FROM saga_processed_events WHERE event_id = $1)
    `, eventID).Scan(&exists)
    return exists, err
}

// MarkEventProcessed records that this event_id has been handled
func (r *PostgresSagaRepository) MarkEventProcessed(ctx context.Context, eventID string, sagaID uuid.UUID) error {
    _, err := r.pool.Exec(ctx, `
        INSERT INTO saga_processed_events (event_id, saga_id)
        VALUES ($1, $2)
        ON CONFLICT (event_id) DO NOTHING
    `, eventID, sagaID)
    return err
}

