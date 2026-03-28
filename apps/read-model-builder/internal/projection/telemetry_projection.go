package projection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/pahuldeepp/grainguard/libs/observability"
)

type TelemetryRecordedEvent struct {
	EventID     string `json:"eventId"`
	EventType   string `json:"eventType"`
	AggregateID string `json:"aggregateId"`
	OccurredAt  string `json:"occurredAt"`
	Data        struct {
		DeviceID    string   `json:"deviceId"`
		Temperature *float64 `json:"temperature"`
		Humidity    *float64 `json:"humidity"`
		TenantID    string   `json:"tenantId"`
	} `json:"data"`
}

type parsedEvent struct {
	eventID     string
	deviceID    uuid.UUID
	tenantID    string
	temperature float64
	humidity    float64
	recordedAt  time.Time
}

func HandleTelemetry(pool *pgxpool.Pool, redisClient redis.UniversalClient) func([]byte) error {
	return func(payload []byte) error {
		start := time.Now()

		observability.InflightJobs.Inc()
		defer observability.InflightJobs.Dec()

		var event TelemetryRecordedEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		if event.EventType != "telemetry.recorded" {
			return nil
		}

		if event.EventID == "" {
			observability.EventsRetry.Inc()
			return errors.New("missing eventId")
		}
		if _, err := uuid.Parse(event.EventID); err != nil {
			observability.EventsRetry.Inc()
			return fmt.Errorf("invalid eventId: %w", err)
		}

		deviceIDStr := event.Data.DeviceID
		if deviceIDStr == "" {
			deviceIDStr = event.AggregateID
		}
		if deviceIDStr == "" {
			observability.EventsRetry.Inc()
			return errors.New("missing deviceId")
		}

		deviceID, err := uuid.Parse(deviceIDStr)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		recordedAt, err := time.Parse(time.RFC3339Nano, event.OccurredAt)
		if err != nil {
			recordedAt, err = time.Parse(time.RFC3339, event.OccurredAt)
			if err != nil {
				observability.EventsRetry.Inc()
				return err
			}
		}

		var temperature float64
		if event.Data.Temperature != nil {
			temperature = *event.Data.Temperature
		}

		var humidity float64
		if event.Data.Humidity != nil {
			humidity = *event.Data.Humidity
		}

		tenantID := event.Data.TenantID

		//nolint:gosec // Projection transactions must finish independently of caller contexts.
		ctx := context.Background()

		tx, err := pool.Begin(ctx)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}
		defer func() {
			_ = tx.Rollback(ctx)
		}()

		var inserted string
		err = tx.QueryRow(
			ctx,
			`INSERT INTO processed_events(event_id)
			 VALUES ($1)
			 ON CONFLICT DO NOTHING
			 RETURNING event_id`,
			event.EventID,
		).Scan(&inserted)

		if errors.Is(err, pgx.ErrNoRows) {
			observability.EventsProcessed.Inc()
			observability.EventProcessingLatency.Observe(time.Since(start).Seconds())
			return tx.Commit(ctx)
		}

		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		var newVersion int64
		err = tx.QueryRow(
			ctx,
			`INSERT INTO device_telemetry_latest
			 (device_id, tenant_id, temperature, humidity, recorded_at, version)
			 VALUES ($1,$2,$3,$4,$5,1)
			 ON CONFLICT (device_id)
			 DO UPDATE SET
				tenant_id   = EXCLUDED.tenant_id,
				temperature = EXCLUDED.temperature,
				humidity    = EXCLUDED.humidity,
				recorded_at = EXCLUDED.recorded_at,
				updated_at  = NOW(),
				version     = device_telemetry_latest.version + 1
			 WHERE EXCLUDED.recorded_at >= device_telemetry_latest.recorded_at
			 RETURNING version`,
			deviceID, tenantID, temperature, humidity, recordedAt,
		).Scan(&newVersion)

		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		// Write to history table for chart queries
		_, err = tx.Exec(
			ctx,
			`INSERT INTO device_telemetry_history
			 (event_id, device_id, tenant_id, temperature, humidity, recorded_at)
			 VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
			event.EventID, deviceID, tenantID, temperature, humidity, recordedAt,
		)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		if commitErr := tx.Commit(ctx); commitErr != nil {
			observability.EventsRetry.Inc()
			return commitErr
		}

		versionKey := "device:" + deviceID.String()
		dataKey := fmt.Sprintf("device:%s:v%d", deviceID.String(), newVersion)

		cachePayload, _ := json.Marshal(map[string]any{
			"device_id":   deviceID.String(),
			"temperature": temperature,
			"humidity":    humidity,
			"recorded_at": recordedAt.Format(time.RFC3339Nano),
			"version":     newVersion,
		})

		if redisClient == nil {
			return nil
		}
		pipe := redisClient.Pipeline()
		pipe.Set(ctx, dataKey, cachePayload, 5*time.Minute)
		pipe.Set(ctx, versionKey, newVersion, 5*time.Minute)

		if _, err = pipe.Exec(ctx); err != nil {
			log.Println("redis pipeline write failed:", err)
		}

		observability.EventsProcessed.Inc()
		observability.EventProcessingLatency.Observe(time.Since(start).Seconds())

		return nil
	}
}

func HandleTelemetryBatch(pool *pgxpool.Pool, redisClient redis.UniversalClient) func(context.Context, [][]byte) error {
	return func(ctx context.Context, payloads [][]byte) error {
		start := time.Now()

		observability.InflightJobs.Inc()
		defer observability.InflightJobs.Dec()

		events := make([]parsedEvent, 0, len(payloads))

		for _, payload := range payloads {
			var event TelemetryRecordedEvent
			if err := json.Unmarshal(payload, &event); err != nil {
				continue
			}
			if event.EventType != "telemetry.recorded" {
				continue
			}
			if event.EventID == "" {
				continue
			}
			if _, err := uuid.Parse(event.EventID); err != nil {
				continue
			}

			deviceIDStr := event.Data.DeviceID
			if deviceIDStr == "" {
				deviceIDStr = event.AggregateID
			}
			if deviceIDStr == "" {
				continue
			}

			deviceID, err := uuid.Parse(deviceIDStr)
			if err != nil {
				continue
			}

			recordedAt, err := time.Parse(time.RFC3339Nano, event.OccurredAt)
			if err != nil {
				recordedAt, err = time.Parse(time.RFC3339, event.OccurredAt)
				if err != nil {
					continue
				}
			}

			var temperature float64
			if event.Data.Temperature != nil {
				temperature = *event.Data.Temperature
			}
			var humidity float64
			if event.Data.Humidity != nil {
				humidity = *event.Data.Humidity
			}

			if event.Data.TenantID == "" {
				continue
			}
			events = append(events, parsedEvent{
				eventID:     event.EventID,
				deviceID:    deviceID,
				tenantID:    event.Data.TenantID,
				temperature: temperature,
				humidity:    humidity,
				recordedAt:  recordedAt,
			})
		}

		if len(events) == 0 {
			return nil
		}

		//nolint:gosec // Batch projection work needs a bounded root context.
		txCtx, txCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer txCancel()

		tx, err := pool.Begin(txCtx)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}
		defer func() {
			_ = tx.Rollback(txCtx)
		}()

		eventIDs := make([]string, len(events))
		for i, e := range events {
			eventIDs[i] = e.eventID
		}

		rows, err := tx.Query(
			txCtx,
			`INSERT INTO processed_events(event_id)
			 SELECT unnest($1::text[])::uuid
			 ON CONFLICT DO NOTHING
			 RETURNING event_id`,
			eventIDs,
		)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		newEventIDs := make(map[string]struct{})
		for rows.Next() {
			var id string
			if scanErr := rows.Scan(&id); scanErr == nil {
				newEventIDs[id] = struct{}{}
			}
		}
		rows.Close()

		newEvents := make([]parsedEvent, 0, len(events))
		for _, e := range events {
			if _, ok := newEventIDs[e.eventID]; ok {
				newEvents = append(newEvents, e)
			}
		}

		if len(newEvents) == 0 {
			observability.EventsProcessed.Add(float64(len(events)))
			observability.EventProcessingLatency.Observe(time.Since(start).Seconds())
			return tx.Commit(txCtx)
		}

		// Deduplicate by deviceID — keep latest recordedAt per device.
		deduped := make(map[uuid.UUID]parsedEvent, len(newEvents))
		for _, e := range newEvents {
			if existing, ok := deduped[e.deviceID]; !ok || !e.recordedAt.Before(existing.recordedAt) {
				deduped[e.deviceID] = e
			}
		}
		dedupedEvents := make([]parsedEvent, 0, len(deduped))
		for _, e := range deduped {
			dedupedEvents = append(dedupedEvents, e)
		}
		sort.Slice(dedupedEvents, func(i, j int) bool {
			return dedupedEvents[i].deviceID.String() < dedupedEvents[j].deviceID.String()
		})

		args := make([]any, 0, len(dedupedEvents)*5)
		valueClauses := make([]string, 0, len(dedupedEvents))

		for i, e := range dedupedEvents {
			base := i * 5
			valueClauses = append(valueClauses,
				fmt.Sprintf("($%d,$%d,$%d,$%d,$%d,1)", base+1, base+2, base+3, base+4, base+5),
			)
			args = append(args, e.deviceID, e.tenantID, e.temperature, e.humidity, e.recordedAt)
		}

		bulkSQL := fmt.Sprintf(`
			INSERT INTO device_telemetry_latest
			(device_id, tenant_id, temperature, humidity, recorded_at, version)
			VALUES %s
			ON CONFLICT (device_id)
			DO UPDATE SET
				tenant_id   = EXCLUDED.tenant_id,
				temperature = EXCLUDED.temperature,
				humidity    = EXCLUDED.humidity,
				recorded_at = EXCLUDED.recorded_at,
				updated_at  = NOW(),
				version     = device_telemetry_latest.version + 1
			WHERE EXCLUDED.recorded_at >= device_telemetry_latest.recorded_at
			RETURNING device_id, version`,
			strings.Join(valueClauses, ","),
		)

		rows, err = tx.Query(txCtx, bulkSQL, args...)
		if err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		type versionResult struct {
			deviceID uuid.UUID
			version  int64
		}
		versions := make([]versionResult, 0, len(dedupedEvents))
		for rows.Next() {
			var r versionResult
			if err := rows.Scan(&r.deviceID, &r.version); err == nil {
				versions = append(versions, r)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		historyRows := make([][]any, 0, len(newEvents))
		sort.Slice(newEvents, func(i, j int) bool {
			if newEvents[i].deviceID == newEvents[j].deviceID {
				if newEvents[i].recordedAt.Equal(newEvents[j].recordedAt) {
					return newEvents[i].eventID < newEvents[j].eventID
				}
				return newEvents[i].recordedAt.Before(newEvents[j].recordedAt)
			}
			return newEvents[i].deviceID.String() < newEvents[j].deviceID.String()
		})
		for _, e := range newEvents {
			historyRows = append(historyRows, []any{
				e.eventID,
				e.deviceID,
				e.tenantID,
				e.temperature,
				e.humidity,
				e.recordedAt,
			})
		}
		if _, err := tx.CopyFrom(
			txCtx,
			pgx.Identifier{"device_telemetry_history"},
			[]string{"event_id", "device_id", "tenant_id", "temperature", "humidity", "recorded_at"},
			pgx.CopyFromRows(historyRows),
		); err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		if err := tx.Commit(txCtx); err != nil {
			observability.EventsRetry.Inc()
			return err
		}

		eventByDevice := make(map[uuid.UUID]parsedEvent, len(dedupedEvents))
		for _, e := range dedupedEvents {
			eventByDevice[e.deviceID] = e
		}

		if redisClient == nil {
			return nil
		}
		pipe := redisClient.Pipeline()
		for _, v := range versions {
			e, ok := eventByDevice[v.deviceID]
			if !ok {
				continue
			}

			versionKey := "device:" + v.deviceID.String() + ":latest_version"
			dataKey := fmt.Sprintf("device:%s:v%d", v.deviceID.String(), v.version)

			cachePayload, _ := json.Marshal(map[string]any{
				"device_id":   v.deviceID.String(),
				"temperature": e.temperature,
				"humidity":    e.humidity,
				"recorded_at": e.recordedAt.Format(time.RFC3339Nano),
				"version":     v.version,
			})

			pipe.Set(ctx, dataKey, cachePayload, 5*time.Minute)
			pipe.Set(ctx, versionKey, v.version, 5*time.Minute)
		}

		if _, err := pipe.Exec(ctx); err != nil {
			log.Println("redis batch pipeline failed:", err)
		}

		observability.EventsProcessed.Add(float64(len(newEvents)))
		observability.EventProcessingLatency.Observe(time.Since(start).Seconds())

		return nil
	}
}
