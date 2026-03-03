package repository

import (
	"context"

	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/domain"
)

type SagaRepository interface {
	Create(ctx context.Context, saga *domain.Saga) error
	FindByCorrelationID(ctx context.Context, correlationID string) (*domain.Saga, error)
	UpdateStepStatus(ctx context.Context, sagaID string, step string, status string) error
	MarkFailed(ctx context.Context, sagaID string, errMsg string) error
}