package recovery

import (
    "context"
    "encoding/json"
    "log"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"

    "github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/domain"
    "github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/producer"
)

type RecoveryWorker struct {
    pool        *pgxpool.Pool
    cmdProducer *producer.Producer
    interval    time.Duration
    timeout     time.Duration
}

func NewRecoveryWorker(pool *pgxpool.Pool, cmdProducer *producer.Producer) *RecoveryWorker {
    return &RecoveryWorker{
        pool:        pool,
        cmdProducer: cmdProducer,
        interval:    30 * time.Second,
        timeout:     5 * time.Minute,
    }
}

func (w *RecoveryWorker) Start(ctx context.Context) {
    log.Println("[recovery] worker started")
    ticker := time.NewTicker(w.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            log.Println("[recovery] worker stopped")
            return
        case <-ticker.C:
            w.recover(ctx)
        }
    }
}

func (w *RecoveryWorker) recover(ctx context.Context) {
    // Sagas stuck > 30 minutes are considered permanently timed-out.
    // Mark them FAILED instead of retrying indefinitely.
    _, err := w.pool.Exec(ctx, `
        UPDATE sagas
        SET status     = 'FAILED',
            last_error = 'saga timed out after 30 minutes without completing',
            updated_at = NOW()
        WHERE status IN ('IN_PROGRESS', 'COMPENSATING')
        AND created_at < NOW() - INTERVAL '30 minutes'
    `)
    if err != nil {
        log.Printf("[recovery] timeout sweep failed: %v", err)
    }

    // Retry sagas that are stuck 5-30 minutes (eligible for retry)
    rows, err := w.pool.Query(ctx, `
        SELECT saga_id, correlation_id, status, current_step, payload
        FROM sagas
        WHERE status IN ('IN_PROGRESS', 'COMPENSATING')
        AND updated_at < NOW() - INTERVAL '5 minutes'
        AND created_at > NOW() - INTERVAL '30 minutes'
    `)
    if err != nil {
        log.Printf("[recovery] query failed: %v", err)
        return
    }
    defer rows.Close()

    for rows.Next() {
        var saga domain.Saga
        var sagaID, correlationID, status, currentStep string
        var payload []byte

        if err := rows.Scan(&sagaID, &correlationID, &status, &currentStep, &payload); err != nil {
            log.Printf("[recovery] scan failed: %v", err)
            continue
        }

        saga.CorrelationID = correlationID
        saga.Status = domain.SagaStatus(status)
        saga.CurrentStep = currentStep
        saga.PayloadJSON = payload

        log.Printf("[recovery] stuck saga found saga_id=%s status=%s step=%s", sagaID, status, currentStep)

        w.retryOrCompensate(ctx, sagaID, &saga)

        // Bump updated_at so this saga is not retried again until next 5-min window
        _, _ = w.pool.Exec(ctx,
            `UPDATE sagas SET updated_at = NOW() WHERE saga_id = $1`, sagaID,
        )
    }
}

func (w *RecoveryWorker) retryOrCompensate(ctx context.Context, sagaID string, saga *domain.Saga) {
    var payload map[string]any
    if err := json.Unmarshal(saga.PayloadJSON, &payload); err != nil {
        log.Printf("[recovery] corrupted payload for saga=%s, marking FAILED: %v", sagaID, err)
        _, _ = w.pool.Exec(ctx,
            `UPDATE sagas SET status = 'FAILED', last_error = $1, updated_at = NOW() WHERE saga_id = $2`,
            "corrupted payload: "+err.Error(), sagaID,
        )
        return
    }

    correlationID := saga.CorrelationID

    switch saga.Status {

    case domain.StatusInProgress:
        // Retry the last command based on current step
        switch saga.CurrentStep {
        case string(domain.StepTenantAttached):
            // Retry attach tenant command
            cmd := map[string]any{
                "command_type":   "tenant.attach_device",
                "correlation_id": correlationID,
                "device_id":      payload["device_id"],
                "tenant_id":      payload["tenant_id"],
                "retry":          true,
            }
            w.publishCommand(ctx, sagaID, correlationID, cmd)

        case string(domain.StepQuotaAllocated):
            // Retry allocate quota command
            cmd := map[string]any{
                "command_type":   "quota.allocate_device",
                "correlation_id": correlationID,
                "device_id":      payload["device_id"],
                "retry":          true,
            }
            w.publishCommand(ctx, sagaID, correlationID, cmd)
        }

    case domain.StatusCompensating:
        // Retry detach tenant command
        cmd := map[string]any{
            "command_type":   "tenant.detach_device",
            "correlation_id": correlationID,
            "device_id":      payload["device_id"],
            "retry":          true,
        }
        w.publishCommand(ctx, sagaID, correlationID, cmd)
    }
}

func (w *RecoveryWorker) publishCommand(ctx context.Context, sagaID, correlationID string, cmd map[string]any) {
    cmdBytes, _ := json.Marshal(cmd)
    if err := w.cmdProducer.Publish(ctx, []byte(correlationID), cmdBytes); err != nil {
        log.Printf("[recovery] failed to publish command saga_id=%s: %v", sagaID, err)
        return
    }
    log.Printf("[recovery] retried command saga_id=%s command=%s", sagaID, cmd["command_type"])
}

