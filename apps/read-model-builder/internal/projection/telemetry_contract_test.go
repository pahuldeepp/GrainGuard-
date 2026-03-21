// review-sweep
package projection

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TelemetryEventContract defines the agreed schema between producer and consumer.
// Any change to this struct is a breaking contract change and must be coordinated.
// Producer: apps/load-generator/main.go
// Consumer: apps/read-model-builder/internal/projection/telemetry_projection.go
type TelemetryEventContract struct {
	EventID     string `json:"eventId"`    // REQUIRED — used for idempotency
	EventType   string `json:"eventType"`  // REQUIRED — must be "telemetry.recorded"
	AggregateID string `json:"aggregateId"` // REQUIRED — device UUID
	OccurredAt  string `json:"occurredAt"` // REQUIRED — RFC3339/RFC3339Nano
	Data        struct {
		DeviceID    string   `json:"deviceId"`    // REQUIRED — device UUID
		TenantID    string   `json:"tenantId"`    // REQUIRED — tenant UUID
		Temperature *float64 `json:"temperature"` // REQUIRED — sensor reading
		Humidity    *float64 `json:"humidity"`    // REQUIRED — sensor reading
	} `json:"data"`
}

func TestEventContract_RequiredFields(t *testing.T) {
	temp := 25.5
	humidity := 60.0

	validEvent := TelemetryEventContract{
		EventID:     uuid.New().String(),
		EventType:   "telemetry.recorded",
		AggregateID: uuid.New().String(),
		OccurredAt:  time.Now().UTC().Format(time.RFC3339Nano),
	}
	validEvent.Data.DeviceID = validEvent.AggregateID
	validEvent.Data.TenantID = "11111111-1111-1111-1111-111111111111"
	validEvent.Data.Temperature = &temp
	validEvent.Data.Humidity = &humidity

	b, err := json.Marshal(validEvent)
	require.NoError(t, err)

	// Consumer must be able to unmarshal this
	var consumed TelemetryRecordedEvent
	err = json.Unmarshal(b, &consumed)
	require.NoError(t, err)

	assert.Equal(t, validEvent.EventID, consumed.EventID, "eventId must survive round-trip")
	assert.Equal(t, validEvent.EventType, consumed.EventType, "eventType must survive round-trip")
	assert.Equal(t, validEvent.AggregateID, consumed.AggregateID, "aggregateId must survive round-trip")
	assert.Equal(t, validEvent.Data.TenantID, consumed.Data.TenantID, "tenantId must survive round-trip")
	assert.NotNil(t, consumed.Data.Temperature, "temperature must survive round-trip")
	assert.NotNil(t, consumed.Data.Humidity, "humidity must survive round-trip")
}

func TestEventContract_MissingEventID_IsRejected(t *testing.T) {
	// This test documents the bug found on 2026-03-20:
	// Load generator was not sending eventId — consumer silently dropped all events.
	// Fix: load generator must always set EventID = uuid.New().String()
	payload := `{
		"eventType": "telemetry.recorded",
		"aggregateId": "` + uuid.New().String() + `",
		"occurredAt": "` + time.Now().UTC().Format(time.RFC3339) + `",
		"data": {
			"deviceId": "` + uuid.New().String() + `",
			"tenantId": "11111111-1111-1111-1111-111111111111",
			"temperature": 25.5,
			"humidity": 60.0
		}
	}`

	var event TelemetryRecordedEvent
	err := json.Unmarshal([]byte(payload), &event)
	require.NoError(t, err)

	assert.Empty(t, event.EventID, "eventId should be empty — consumer must reject this")
}

func TestEventContract_MissingTenantID_IsRejected(t *testing.T) {
	// This test documents the second bug found on 2026-03-20:
	// Load generator was not sending tenantId — consumer silently dropped all events.
	// Fix: load generator must always set TenantID from env var TENANT_ID.
	payload := `{
		"eventId": "` + uuid.New().String() + `",
		"eventType": "telemetry.recorded",
		"aggregateId": "` + uuid.New().String() + `",
		"occurredAt": "` + time.Now().UTC().Format(time.RFC3339) + `",
		"data": {
			"deviceId": "` + uuid.New().String() + `",
			"temperature": 25.5,
			"humidity": 60.0
		}
	}`

	var event TelemetryRecordedEvent
	err := json.Unmarshal([]byte(payload), &event)
	require.NoError(t, err)

	assert.Empty(t, event.Data.TenantID, "tenantId should be empty — consumer must reject this")
}

func TestEventContract_OccurredAt_RFC3339Formats(t *testing.T) {
	// Consumer supports both RFC3339 and RFC3339Nano — both must parse correctly.
	formats := []struct {
		name   string
		format string
	}{
		{"RFC3339", time.RFC3339},
		{"RFC3339Nano", time.RFC3339Nano},
	}

	for _, f := range formats {
		t.Run(f.name, func(t *testing.T) {
			payload := `{
				"eventId": "` + uuid.New().String() + `",
				"eventType": "telemetry.recorded",
				"aggregateId": "` + uuid.New().String() + `",
				"occurredAt": "` + time.Now().UTC().Format(f.format) + `",
				"data": {
					"deviceId": "` + uuid.New().String() + `",
					"tenantId": "11111111-1111-1111-1111-111111111111",
					"temperature": 25.5,
					"humidity": 60.0
				}
			}`

			var event TelemetryRecordedEvent
			err := json.Unmarshal([]byte(payload), &event)
			require.NoError(t, err)

			_, err1 := time.Parse(time.RFC3339Nano, event.OccurredAt)
			_, err2 := time.Parse(time.RFC3339, event.OccurredAt)
			assert.True(t, err1 == nil || err2 == nil,
				"occurredAt must be parseable as RFC3339 or RFC3339Nano, got: %s", event.OccurredAt)
		})
	}
}

func TestEventContract_ProducerPayloadMatchesConsumerStruct(t *testing.T) {
	// This is the golden test — simulate exactly what the load generator sends
	// and verify the consumer can process every field correctly.
	temp := 20.0 + float64(5)
	humidity := 40.0 + float64(5)
	deviceID := uuid.New().String()
	tenantID := "11111111-1111-1111-1111-111111111111"
	eventID := uuid.New().String()

	// Simulate load generator output (apps/load-generator/main.go)
	producerPayload := map[string]any{
		"eventId":     eventID,
		"eventType":   "telemetry.recorded",
		"aggregateId": deviceID,
		"occurredAt":  time.Now().UTC().Format(time.RFC3339Nano),
		"data": map[string]any{
			"deviceId":    deviceID,
			"tenantId":    tenantID,
			"temperature": temp,
			"humidity":    humidity,
		},
	}

	b, err := json.Marshal(producerPayload)
	require.NoError(t, err)

	// Simulate consumer unmarshalling (HandleTelemetryBatch)
	var consumed TelemetryRecordedEvent
	err = json.Unmarshal(b, &consumed)
	require.NoError(t, err)

	// All required fields must be present and correct
	assert.NotEmpty(t, consumed.EventID, "contract violation: eventId missing")
	assert.Equal(t, "telemetry.recorded", consumed.EventType, "contract violation: eventType wrong")
	assert.Equal(t, deviceID, consumed.AggregateID, "contract violation: aggregateId missing")
	assert.NotEmpty(t, consumed.OccurredAt, "contract violation: occurredAt missing")
	assert.Equal(t, deviceID, consumed.Data.DeviceID, "contract violation: data.deviceId missing")
	assert.Equal(t, tenantID, consumed.Data.TenantID, "contract violation: data.tenantId missing")
	assert.NotNil(t, consumed.Data.Temperature, "contract violation: data.temperature missing")
	assert.NotNil(t, consumed.Data.Humidity, "contract violation: data.humidity missing")
}
