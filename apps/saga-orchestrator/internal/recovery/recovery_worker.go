package recovery

import (
	"context"
	"encoding/json"
	"log"
	"sync"
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
	concurrency int
}

func NewRecoveryWorker(pool *pgxpool.Pool, cmdProducer *producer.Producer) *RecoveryWorker {
	return &RecoveryWorker{
		pool:        pool,
		cmdProducer: cmdProducer,
		interval:    30 * time.Second,
		timeout:     5 * time.Minute,
		concurrency: 10, // process up to 10 stuck sagas in parallel
	}
}

func (w *RecoveryWorker) Start(ctx context.Context) {
	log.Printf("[recovery] worker started — interval=%s concurrency=%d", w.interval, w.concurrency)
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

type stuckSaga struct {
	sagaID        string
	correlationID string
	status        string
	currentStep   string
	payload       []byte
}

func (w *RecoveryWorker) recover(ctx context.Context) {
	rows, err := w.pool.Query(ctx, `
		SELECT saga_id, correlation_id, status, current_step, payload
		FROM sagas
		WHERE status IN ('IN_PROGRESS', 'COMPENSATING')
		AND updated_at < NOW() - INTERVAL '5 minutes'
	`)
	if err != nil {
		log.Printf("[recovery] query failed: %v", err)
		return
	}
	defer rows.Close()

	var sagas []stuckSaga
	for rows.Next() {
		var s stuckSaga
		if err := rows.Scan(&s.sagaID, &s.correlationID, &s.status, &s.currentStep, &s.payload); err != nil {
			log.Printf("[recovery] scan failed: %v", err)
			continue
		}
		sagas = append(sagas, s)
	}

	if len(sagas) == 0 {
		return
	}

	log.Printf("[recovery] found %d stuck sagas — processing in parallel", len(sagas))

	// ── Parallel recovery with semaphore ─────────────────────────────────
	sem := make(chan struct{}, w.concurrency)
	var wg sync.WaitGroup

	for _, s := range sagas {
		wg.Add(1)
		go func(s stuckSaga) {
			defer wg.Done()
			sem <- struct{}{}        // acquire
			defer func() { <-sem }() // release

			log.Printf("[recovery] stuck saga found saga_id=%s status=%s step=%s", s.sagaID, s.status, s.currentStep)

			saga := &domain.Saga{
				CorrelationID: s.correlationID,
				Status:        domain.SagaStatus(s.status),
				CurrentStep:   s.currentStep,
				PayloadJSON:   s.payload,
			}

			w.retryOrCompensate(ctx, s.sagaID, saga)
		}(s)
	}

	wg.Wait()
	log.Printf("[recovery] processed %d stuck sagas", len(sagas))
}

func (w *RecoveryWorker) retryOrCompensate(ctx context.Context, sagaID string, saga *domain.Saga) {
	var payload map[string]any
	_ = json.Unmarshal(saga.PayloadJSON, &payload)

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
