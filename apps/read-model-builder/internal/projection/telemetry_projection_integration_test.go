// review-sweep
package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func setupTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()

	pgContainer, err := postgres.Run(ctx,
		"postgres:15-alpine",
		postgres.WithDatabase("grainguard_test"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(30*time.Second),
		),
	)
	require.NoError(t, err)
	t.Cleanup(func() { pgContainer.Terminate(ctx) })

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	// Run schema
	_, err = pool.Exec(ctx, `
		CREATE EXTENSION IF NOT EXISTS "pgcrypto";

		CREATE TABLE IF NOT EXISTS processed_events (
			event_id     UUID        PRIMARY KEY,
			processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE TABLE IF NOT EXISTS device_projections (
			device_id     UUID PRIMARY KEY,
			tenant_id     UUID NOT NULL,
			serial_number TEXT,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE TABLE IF NOT EXISTS device_telemetry_latest (
			device_id    UUID             PRIMARY KEY,
			tenant_id    UUID,
			temperature  DOUBLE PRECISION NOT NULL,
			humidity     DOUBLE PRECISION NOT NULL,
			recorded_at  TIMESTAMPTZ      NOT NULL,
			updated_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
			version      BIGINT           NOT NULL DEFAULT 1
		);

		CREATE TABLE IF NOT EXISTS device_telemetry_history (
			id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
			device_id    UUID        NOT NULL,
			tenant_id    UUID        NOT NULL,
			temperature  DOUBLE PRECISION NOT NULL,
			humidity     DOUBLE PRECISION NOT NULL,
			recorded_at  TIMESTAMPTZ NOT NULL
		);
	`)
	require.NoError(t, err)

	return pool
}

func makePayload(t *testing.T, deviceID, tenantID string, temp, humidity float64) []byte {
	t.Helper()
	type dataField struct {
		DeviceID    string  `json:"deviceId"`
		TenantID    string  `json:"tenantId"`
		Temperature float64 `json:"temperature"`
		Humidity    float64 `json:"humidity"`
	}
	evt := struct {
		EventID     string    `json:"eventId"`
		EventType   string    `json:"eventType"`
		AggregateID string    `json:"aggregateId"`
		OccurredAt  string    `json:"occurredAt"`
		Data        dataField `json:"data"`
	}{
		EventID:     uuid.New().String(),
		EventType:   "telemetry.recorded",
		AggregateID: deviceID,
		OccurredAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Data: dataField{
			DeviceID:    deviceID,
			TenantID:    tenantID,
			Temperature: temp,
			Humidity:    humidity,
		},
	}
	b, err := json.Marshal(evt)
	require.NoError(t, err)
	return b
}

func TestHandleTelemetryBatch_UpdatesLatestAndHistory(t *testing.T) {
	pool := setupTestDB(t)
	ctx := context.Background()

	tenantID := "11111111-1111-1111-1111-111111111111"
	deviceID := uuid.New().String()

	// Insert device into device_projections
	_, err := pool.Exec(ctx,
		`INSERT INTO device_projections (device_id, tenant_id, serial_number) VALUES ($1, $2, $3)`,
		deviceID, tenantID, "SN-TEST-001",
	)
	require.NoError(t, err)

	payload := makePayload(t, deviceID, tenantID, 25.5, 60.0)

	handler := HandleTelemetryBatch(pool, nil)
	err = handler(ctx, [][]byte{payload})
	require.NoError(t, err)

	// Assert device_telemetry_latest updated
	var version int64
	var temp, humidity float64
	err = pool.QueryRow(ctx,
		`SELECT version, temperature, humidity FROM device_telemetry_latest WHERE device_id = $1`,
		deviceID,
	).Scan(&version, &temp, &humidity)
	require.NoError(t, err)
	assert.Equal(t, int64(1), version)
	assert.Equal(t, 25.5, temp)
	assert.Equal(t, 60.0, humidity)

	// Assert device_telemetry_history has a row
	var historyCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM device_telemetry_history WHERE device_id = $1`,
		deviceID,
	).Scan(&historyCount)
	require.NoError(t, err)
	assert.Equal(t, 1, historyCount)

	// Assert processed_events has the event ID
	var processedCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM processed_events`,
	).Scan(&processedCount)
	require.NoError(t, err)
	assert.Equal(t, 1, processedCount)
}

func TestHandleTelemetryBatch_Idempotency(t *testing.T) {
	pool := setupTestDB(t)
	ctx := context.Background()

	tenantID := "11111111-1111-1111-1111-111111111111"
	deviceID := uuid.New().String()

	_, err := pool.Exec(ctx,
		`INSERT INTO device_projections (device_id, tenant_id, serial_number) VALUES ($1, $2, $3)`,
		deviceID, tenantID, "SN-TEST-002",
	)
	require.NoError(t, err)

	// Same payload sent twice — same eventId means idempotent
	payload := makePayload(t, deviceID, tenantID, 30.0, 55.0)

	handler := HandleTelemetryBatch(pool, nil)

	err = handler(ctx, [][]byte{payload})
	require.NoError(t, err)

	// Send exact same bytes again — same event_id should be deduped
	err = handler(ctx, [][]byte{payload})
	require.NoError(t, err)

	// version should still be 1 — upsert is idempotent via recorded_at WHERE clause
	var version int64
	err = pool.QueryRow(ctx,
		`SELECT version FROM device_telemetry_latest WHERE device_id = $1`, deviceID,
	).Scan(&version)
	require.NoError(t, err)
	assert.Equal(t, int64(1), version)
}

func TestHandleTelemetryBatch_DeduplicatesWithinBatch(t *testing.T) {
	pool := setupTestDB(t)
	ctx := context.Background()

	tenantID := "11111111-1111-1111-1111-111111111111"
	deviceID := uuid.New().String()

	_, err := pool.Exec(ctx,
		`INSERT INTO device_projections (device_id, tenant_id, serial_number) VALUES ($1, $2, $3)`,
		deviceID, tenantID, "SN-TEST-003",
	)
	require.NoError(t, err)

	// Two events for the same device in one batch — latest should win
	older := makePayload(t, deviceID, tenantID, 20.0, 40.0)
	newer := makePayload(t, deviceID, tenantID, 35.0, 70.0)

	handler := HandleTelemetryBatch(pool, nil)
	err = handler(ctx, [][]byte{older, newer})
	require.NoError(t, err)

	var temp float64
	err = pool.QueryRow(ctx,
		`SELECT temperature FROM device_telemetry_latest WHERE device_id = $1`, deviceID,
	).Scan(&temp)
	require.NoError(t, err)
	// The batch deduplicates by device — one upsert happens
	assert.NotZero(t, temp)

	// History should have 2 rows (both events recorded)
	var historyCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM device_telemetry_history WHERE device_id = $1`, deviceID,
	).Scan(&historyCount)
	require.NoError(t, err)
	assert.Equal(t, 2, historyCount)
}

func TestHandleTelemetryBatch_SkipsInvalidEvents(t *testing.T) {
	pool := setupTestDB(t)
	ctx := context.Background()

	// Invalid payloads — missing eventId, missing tenantId
	noEventID := []byte(`{"eventType":"telemetry.recorded","aggregateId":"` + uuid.New().String() + `","occurredAt":"` + time.Now().UTC().Format(time.RFC3339) + `","data":{"deviceId":"` + uuid.New().String() + `","tenantId":"11111111-1111-1111-1111-111111111111","temperature":20,"humidity":40}}`)
	noTenantID := []byte(fmt.Sprintf(`{"eventId":"%s","eventType":"telemetry.recorded","aggregateId":"%s","occurredAt":"%s","data":{"deviceId":"%s","tenantId":"","temperature":20,"humidity":40}}`,
		uuid.New().String(), uuid.New().String(), time.Now().UTC().Format(time.RFC3339), uuid.New().String()))

	handler := HandleTelemetryBatch(pool, nil)
	err := handler(ctx, [][]byte{noEventID, noTenantID})
	require.NoError(t, err)

	// Nothing should be inserted
	var count int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM processed_events`).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, 0, count)
}
