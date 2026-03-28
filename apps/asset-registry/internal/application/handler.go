package application

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pahuldeepp/grainguard/apps/asset-registry/internal/kafka"
)

const freeDeviceLimit = 5

var billingGraceStatuses = map[string]struct{}{
	"past_due":  {},
	"cancelled": {},
}

type CommandHandler struct {
	pool      *pgxpool.Pool
	publisher *kafka.EventPublisher
}

func NewCommandHandler(pool *pgxpool.Pool, publisher *kafka.EventPublisher) *CommandHandler {
	return &CommandHandler{pool: pool, publisher: publisher}
}

func parseTime(value any) *time.Time {
	switch typed := value.(type) {
	case time.Time:
		if typed.IsZero() {
			return nil
		}
		t := typed.UTC()
		return &t
	case *time.Time:
		if typed == nil || typed.IsZero() {
			return nil
		}
		t := typed.UTC()
		return &t
	case string:
		if typed == "" {
			return nil
		}
		if parsed, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			t := parsed.UTC()
			return &t
		}
		if parsed, err := time.Parse(time.RFC3339, typed); err == nil {
			t := parsed.UTC()
			return &t
		}
	}
	return nil
}

func hasPaidAccess(plan string, subscriptionStatus string, currentPeriodEnd *time.Time) bool {
	switch subscriptionStatus {
	case "active", "trialing":
		return plan != "free"
	}

	_, inGrace := billingGraceStatuses[subscriptionStatus]
	return plan != "free" && inGrace && currentPeriodEnd != nil && currentPeriodEnd.After(time.Now().UTC())
}

func planLimit(plan string, subscriptionStatus string, currentPeriodEnd *time.Time) int {
	if !hasPaidAccess(plan, subscriptionStatus, currentPeriodEnd) {
		return freeDeviceLimit
	}

	switch plan {
	case "enterprise":
		return -1
	case "professional":
		return 100
	case "starter":
		return 10
	default:
		return freeDeviceLimit
	}
}

func (h *CommandHandler) publishQuotaFailed(
	ctx context.Context,
	deviceID string,
	tenantID string,
	correlationID string,
	reason string,
) error {
	return h.publisher.Publish(ctx, "quota_allocation_failed_v1", correlationID, tenantID, map[string]any{
		"device_id": deviceID,
		"tenant_id": tenantID,
		"reason":    reason,
	})
}

func (h *CommandHandler) HandleAttachDevice(ctx context.Context, deviceID, tenantID, correlationID string) error {
	log.Printf("[asset-registry] attaching device=%s tenant=%s", deviceID, tenantID)

	var storedTenantID string
	err := h.pool.QueryRow(
		ctx,
		`SELECT tenant_id FROM devices WHERE id = $1`,
		deviceID,
	).Scan(&storedTenantID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("device %s not found", deviceID)
		}
		return err
	}

	if storedTenantID != tenantID {
		log.Printf(
			"[asset-registry] tenant mismatch for device=%s commandTenant=%s dbTenant=%s; using persisted tenant",
			deviceID,
			tenantID,
			storedTenantID,
		)
		tenantID = storedTenantID
	}

	return h.publisher.Publish(ctx, "tenant_attached_v1", correlationID, tenantID, map[string]any{
		"device_id": deviceID,
		"tenant_id": tenantID,
	})
}

func (h *CommandHandler) HandleAllocateQuota(ctx context.Context, deviceID, tenantID, correlationID string) error {
	log.Printf("[asset-registry] allocating quota device=%s tenant=%s", deviceID, tenantID)

	var (
		plan               string
		subscriptionStatus string
		currentPeriodEnd   any
		deviceCount        int
	)

	err := h.pool.QueryRow(
		ctx,
		`SELECT t.plan,
		        t.subscription_status,
		        t.current_period_end,
		        (SELECT COUNT(*) FROM devices WHERE tenant_id = $1) AS device_count
		   FROM tenants t
		  WHERE t.id = $1`,
		tenantID,
	).Scan(&plan, &subscriptionStatus, &currentPeriodEnd, &deviceCount)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("tenant %s not found", tenantID)
		}
		return err
	}

	limit := planLimit(plan, subscriptionStatus, parseTime(currentPeriodEnd))
	if limit != -1 && deviceCount > limit {
		log.Printf(
			"[asset-registry] quota rejected tenant=%s device=%s count=%d limit=%d plan=%s status=%s",
			tenantID,
			deviceID,
			deviceCount,
			limit,
			plan,
			subscriptionStatus,
		)
		return h.publishQuotaFailed(ctx, deviceID, tenantID, correlationID, "device_quota_exceeded")
	}

	return h.publisher.Publish(ctx, "quota_allocated_v1", correlationID, tenantID, map[string]any{
		"device_id":  deviceID,
		"tenant_id":  tenantID,
		"plan":       plan,
		"limit":      limit,
		"checked_at": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (h *CommandHandler) HandleDetachDevice(ctx context.Context, deviceID, tenantID, correlationID string) error {
	log.Printf("[asset-registry] detaching device=%s tenant=%s (compensation)", deviceID, tenantID)

	_, err := h.pool.Exec(
		ctx,
		`DELETE FROM devices
		  WHERE id = $1
		    AND tenant_id = $2`,
		deviceID,
		tenantID,
	)
	if err != nil {
		return err
	}

	return h.publisher.Publish(ctx, "tenant_detached_v1", correlationID, tenantID, map[string]any{
		"device_id": deviceID,
		"tenant_id": tenantID,
	})
}
