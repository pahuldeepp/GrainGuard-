package audit

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type EventType string

const (
	EventDeviceCreated         EventType = "device.created"
	EventDeviceProvisioned     EventType = "device.provisioned"
	EventDeviceProvisionFailed EventType = "device.provision_failed"
	EventTenantSwitched        EventType = "tenant.switched"
	EventTelemetryRecorded     EventType = "telemetry.recorded"
	EventSagaStarted           EventType = "saga.started"
	EventSagaCompleted         EventType = "saga.completed"
	EventSagaFailed            EventType = "saga.failed"
	EventAdminAction           EventType = "admin.action"
)

type Event struct {
	EventType    EventType
	ActorID      string
	TenantID     uuid.UUID
	ResourceType string
	ResourceID   string
	Payload      map[string]any
	IPAddress    string
	UserAgent    string
}

type Logger struct {
	pool *pgxpool.Pool
}

func NewLogger(pool *pgxpool.Pool) *Logger {
	return &Logger{pool: pool}
}

func (l *Logger) Log(ctx context.Context, event Event) {
	// Fire and forget — use Background() to decouple from request lifecycle
	// The caller context may be cancelled after the request completes
	//nolint:gosec // Audit writes must outlive the request context.
	go func() {
		if err := l.write(context.Background(), event); err != nil {
			log.Printf("[audit] failed to write event=%s actor=%s err=%v",
				event.EventType, event.ActorID, err)
		}
	}()
}

func (l *Logger) LogSync(ctx context.Context, event Event) error {
	return l.write(ctx, event)
}

func (l *Logger) write(ctx context.Context, event Event) error {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		payload = []byte("{}")
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err = l.pool.Exec(ctx,
		`INSERT INTO audit_events
		 (event_type, actor_id, tenant_id, resource_type, resource_id, payload, ip_address, user_agent)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		string(event.EventType),
		event.ActorID,
		event.TenantID,
		event.ResourceType,
		event.ResourceID,
		string(payload),
		event.IPAddress,
		event.UserAgent,
	)
	return err
}
