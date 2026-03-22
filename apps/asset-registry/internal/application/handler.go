package application

import (
	"context"
	"log"

	"github.com/pahuldeepp/grainguard/apps/asset-registry/internal/kafka"
)

type CommandHandler struct {
	publisher *kafka.EventPublisher
}

func NewCommandHandler(publisher *kafka.EventPublisher) *CommandHandler {
	return &CommandHandler{publisher: publisher}
}

// HandleAttachDevice — tenant.attach_device command received
// Attaches device to tenant, publishes tenant_attached_v1
func (h *CommandHandler) HandleAttachDevice(ctx context.Context, deviceID, tenantID, correlationID string) error {
	log.Printf("[asset-registry] attaching device=%s tenant=%s", deviceID, tenantID)

	// In production: update device record, validate tenant exists
	// For now: publish success event back to saga

	return h.publisher.Publish(ctx, "tenant_attached_v1", correlationID, tenantID, map[string]any{
		"device_id": deviceID,
		"tenant_id": tenantID,
	})
}

// HandleAllocateQuota — quota.allocate_device command received
// Allocates quota for device, publishes quota_allocated_v1
func (h *CommandHandler) HandleAllocateQuota(ctx context.Context, deviceID, tenantID, correlationID string) error {
	log.Printf("[asset-registry] allocating quota device=%s tenant=%s", deviceID, tenantID)

	// In production: check tenant quota limits, reserve slot
	// For now: publish success event back to saga

	return h.publisher.Publish(ctx, "quota_allocated_v1", correlationID, tenantID, map[string]any{
		"device_id": deviceID,
		"tenant_id": tenantID,
	})
}

// HandleDetachDevice — tenant.detach_device command received (compensation)
// Detaches device from tenant, publishes tenant_detached_v1
func (h *CommandHandler) HandleDetachDevice(ctx context.Context, deviceID, tenantID, correlationID string) error {
	log.Printf("[asset-registry] detaching device=%s tenant=%s (compensation)", deviceID, tenantID)

	return h.publisher.Publish(ctx, "tenant_detached_v1", correlationID, tenantID, map[string]any{
		"device_id": deviceID,
		"tenant_id": tenantID,
	})
}
