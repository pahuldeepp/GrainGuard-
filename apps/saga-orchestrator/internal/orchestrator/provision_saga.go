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


)

type ProvisionSaga struct {
	repo       repository.SagaRepository
	cmdProducer *producer.Producer
}

func NewProvisionSaga(repo repository.SagaRepository, cmdProducer *producer.Producer) *ProvisionSaga {
	return &ProvisionSaga{
		repo: repo,
		cmdProducer: cmdProducer,
	}
}

func (p *ProvisionSaga) HandleEvent(ctx context.Context, raw []byte) error {
	env, err := ParseEnvelope(raw)
	if err != nil {
		return err
	}

	// We only start saga on device_created_v1
	payload := env.GetDeviceCreatedV1()
	if payload == nil {
		// Not relevant event — ignore successfully
		return nil
	}

	// CorrelationID strategy: use aggregate_id or event_id
	// Here: correlation = aggregate_id (device_id)
	correlationID := env.GetAggregateId()
	if correlationID == "" {
		correlationID = payload.GetDeviceId()
	}

	// Idempotency: if saga exists for correlation, do nothing
	_, findErr := p.repo.FindByCorrelationID(ctx, correlationID)
	if findErr == nil {
		return nil // already started
	}
	if !errors.Is(findErr, pgx.ErrNoRows) {
		return findErr
	}

	// Create saga
	sagaID := uuid.New()
	initialPayload, _ := json.Marshal(map[string]any{
		"device_id": payload.GetDeviceId(),
		"tenant_id": payload.GetTenantId(),
		"serial":    payload.GetSerial(),
		"created_at": payload.GetCreatedAt(),
		"event_id":  env.GetEventId(),
	})

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

	// Publish next command: AttachTenantCommand (example)
	cmd := map[string]any{
		"command_type":    "tenant.attach_device",
		"correlation_id":  correlationID,
		"device_id":       payload.GetDeviceId(),
		"tenant_id":       payload.GetTenantId(),
		"occurred_at_ms":  env.GetOccurredAtUnixMs(),
	}

	cmdBytes, _ := json.Marshal(cmd)

	if err := p.cmdProducer.Publish(ctx, []byte(correlationID), cmdBytes); err != nil {
		_ = p.repo.MarkFailed(ctx, sagaID.String(), "failed to publish tenant.attach_device command")
		return fmt.Errorf("publish command: %w", err)
	}

	// Update saga step/status after command published
	if err := p.repo.UpdateStepStatus(ctx, sagaID.String(), string(domain.StepTenantAttached), string(domain.StatusInProgress)); err != nil {
		return fmt.Errorf("update saga step: %w", err)
	}

	return nil
}