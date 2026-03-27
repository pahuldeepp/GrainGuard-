package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/domain"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/producer"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/repository"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
)

type ProvisionSaga struct {
	repo        repository.SagaRepository
	cmdProducer *producer.Producer
}

func NewProvisionSaga(repo repository.SagaRepository, cmdProducer *producer.Producer) *ProvisionSaga {
	return &ProvisionSaga{
		repo:        repo,
		cmdProducer: cmdProducer,
	}
}

func (p *ProvisionSaga) HandleEvent(ctx context.Context, raw []byte) error {
	env, err := ParseEnvelope(raw)
	if err != nil {
		return err
	}

	// ── Step 1: device_created_v1 → start saga, publish attach command ──
	if payload := env.GetDeviceCreatedV1(); payload != nil {
		correlationID := env.GetAggregateId()
		if correlationID == "" {
			correlationID = payload.GetDeviceId()
		}

		// Idempotency: skip if saga already exists
		_, findErr := p.repo.FindByCorrelationID(ctx, correlationID)
		if findErr == nil {
			return nil
		}
		if !errors.Is(findErr, pgx.ErrNoRows) {
			return findErr
		}

		sagaID := uuid.New()
		initialPayload, initialErr := json.Marshal(map[string]any{
			"device_id":  payload.GetDeviceId(),
			"tenant_id":  payload.GetTenantId(),
			"serial":     payload.GetSerial(),
			"created_at": payload.GetCreatedAt(),
			"event_id":   env.GetEventId(),
		})
		if initialErr != nil {
			return fmt.Errorf("marshal initial payload: %w", initialErr)
		}

		saga := &domain.Saga{
			ID:            sagaID,
			Type:          domain.SagaProvisionDevice,
			CorrelationID: correlationID,
			Status:        domain.StatusStarted,
			CurrentStep:   string(domain.StepDeviceCreated),
			PayloadJSON:   initialPayload,
		}

		if err := p.repo.Create(ctx, saga); err != nil {
			return fmt.Errorf("create saga: %w", err)
		}

		cmd := map[string]any{
			"command_type":   "tenant.attach_device",
			"correlation_id": correlationID,
			"device_id":      payload.GetDeviceId(),
			"tenant_id":      payload.GetTenantId(),
			"occurred_at_ms": env.GetOccurredAtUnixMs(),
		}
		cmdBytes, cmdErr := json.Marshal(cmd)
		if cmdErr != nil {
			return fmt.Errorf("marshal tenant.attach_device command: %w", cmdErr)
		}

		if err := p.cmdProducer.Publish(ctx, []byte(correlationID), cmdBytes); err != nil {
			_ = p.repo.MarkFailed(ctx, sagaID.String(), "failed to publish tenant.attach_device")
			return fmt.Errorf("publish command: %w", err)
		}

		return p.repo.UpdateStepStatus(ctx, sagaID.String(),
			string(domain.StepTenantAttached),
			string(domain.StatusInProgress),
		)
	}

	// ── Route remaining events by EventType string ───────────────────────
	switch env.GetEventType() {
	case "tenant_attached_v1":
		return p.handleTenantAttached(ctx, env)
	case "quota_allocated_v1":
		return p.handleQuotaAllocated(ctx, env)
	case "quota_allocation_failed_v1":
		return p.handleQuotaAllocationFailed(ctx, env)
	case "tenant_detached_v1":
		return p.handleTenantDetached(ctx, env)
	}

	return nil
}

// ── Step 2: tenant attached → publish allocate quota command ─────────────
func (p *ProvisionSaga) handleTenantAttached(ctx context.Context, env *eventspb.EventEnvelope) error {
	correlationID := env.GetAggregateId()

	saga, err := p.repo.FindByCorrelationID(ctx, correlationID)
	if err != nil {
		return fmt.Errorf("find saga: %w", err)
	}

	cmd := map[string]any{
		"command_type":   "quota.allocate_device",
		"correlation_id": correlationID,
		"device_id":      correlationID,
		"tenant_id":      env.GetTenantId(),
		"occurred_at_ms": env.GetOccurredAtUnixMs(),
	}
	cmdBytes, detachErr := json.Marshal(cmd)
	if detachErr != nil {
		return fmt.Errorf("marshal tenant.detach_device command: %w", detachErr)
	}

	if err := p.cmdProducer.Publish(ctx, []byte(correlationID), cmdBytes); err != nil {
		_ = p.repo.MarkFailed(ctx, saga.ID.String(), "failed to publish quota.allocate_device")
		return fmt.Errorf("publish command: %w", err)
	}

	return p.repo.UpdateStepStatus(ctx, saga.ID.String(),
		string(domain.StepQuotaAllocated),
		string(domain.StatusInProgress),
	)
}

// ── Step 3: quota allocated → saga complete ──────────────────────────────
func (p *ProvisionSaga) handleQuotaAllocated(ctx context.Context, env *eventspb.EventEnvelope) error {
	correlationID := env.GetAggregateId()

	saga, err := p.repo.FindByCorrelationID(ctx, correlationID)
	if err != nil {
		return fmt.Errorf("find saga: %w", err)
	}

	return p.repo.UpdateStepStatus(ctx, saga.ID.String(),
		string(domain.StepQuotaAllocated),
		string(domain.StatusCompleted),
	)
}

// ── Step 4a: quota failed → publish detach command (compensation) ────────
func (p *ProvisionSaga) handleQuotaAllocationFailed(ctx context.Context, env *eventspb.EventEnvelope) error {
	correlationID := env.GetAggregateId()

	saga, err := p.repo.FindByCorrelationID(ctx, correlationID)
	if err != nil {
		return fmt.Errorf("find saga: %w", err)
	}

	cmd := map[string]any{
		"command_type":   "tenant.detach_device",
		"correlation_id": correlationID,
		"device_id":      correlationID,
		"tenant_id":      env.GetTenantId(),
		"occurred_at_ms": env.GetOccurredAtUnixMs(),
	}
	cmdBytes, _ := json.Marshal(cmd)

	if err := p.cmdProducer.Publish(ctx, []byte(correlationID), cmdBytes); err != nil {
		_ = p.repo.MarkFailed(ctx, saga.ID.String(), "failed to publish tenant.detach_device")
		return fmt.Errorf("publish command: %w", err)
	}

	return p.repo.UpdateStepStatus(ctx, saga.ID.String(),
		string(domain.StepTenantAttached),
		string(domain.StatusCompensating),
	)
}

// ── Step 4b: tenant detached → saga compensated ──────────────────────────
func (p *ProvisionSaga) handleTenantDetached(ctx context.Context, env *eventspb.EventEnvelope) error {
	correlationID := env.GetAggregateId()

	saga, err := p.repo.FindByCorrelationID(ctx, correlationID)
	if err != nil {
		return fmt.Errorf("find saga: %w", err)
	}

	return p.repo.UpdateStepStatus(ctx, saga.ID.String(),
		string(domain.StepDeviceCreated),
		string(domain.StatusFailed),
	)
}
