// review-sweep
package transform_test

import (
	"encoding/json"
	"testing"

	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/transform"
)

func makeDebeziumEvent(op, deviceID string, temp, humidity *float64) []byte {
	after := map[string]any{
		"device_id":   deviceID,
		"recorded_at": "2024-03-17T08:05:38.000000Z",
		"tenant_id":   "11111111-1111-1111-1111-111111111111",
	}
	if temp != nil {
		after["temperature"] = *temp
	}
	if humidity != nil {
		after["humidity"] = *humidity
	}

	payload := map[string]any{
		"payload": map[string]any{
			"op":    op,
			"after": after,
			"ts_ms": int64(1710662738000),
		},
	}
	b, _ := json.Marshal(payload)
	return b
}

func ptr(f float64) *float64 { return &f }

func TestTransformTelemetry_ValidInsert(t *testing.T) {
	raw := makeDebeziumEvent("c", "abc-device-123", ptr(24.5), ptr(65.0))
	evt, err := transform.TransformTelemetry(raw, "test.topic", 0, 42)

	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if evt == nil {
		t.Fatal("expected event, got nil")
	}
	if evt.EventType != "telemetry.recorded" {
		t.Errorf("EventType: want telemetry.recorded got %q", evt.EventType)
	}
	if evt.AggregateID != "abc-device-123" {
		t.Errorf("AggregateID: want abc-device-123 got %q", evt.AggregateID)
	}
	if evt.EventID == "" {
		t.Error("EventID should not be empty")
	}
	if evt.Data["temperature"] != 24.5 {
		t.Errorf("temperature: want 24.5 got %v", evt.Data["temperature"])
	}
	if evt.Data["humidity"] != 65.0 {
		t.Errorf("humidity: want 65.0 got %v", evt.Data["humidity"])
	}
}

func TestTransformTelemetry_ValidUpdate(t *testing.T) {
	raw := makeDebeziumEvent("u", "device-456", ptr(30.0), ptr(70.0))
	evt, err := transform.TransformTelemetry(raw, "test.topic", 0, 1)

	if err != nil {
		t.Fatalf("expected no error for update op, got: %v", err)
	}
	if evt.AggregateID != "device-456" {
		t.Errorf("AggregateID: want device-456 got %q", evt.AggregateID)
	}
}

func TestTransformTelemetry_DeleteOpSkipped(t *testing.T) {
	raw := makeDebeziumEvent("d", "device-123", nil, nil)
	_, err := transform.TransformTelemetry(raw, "test.topic", 0, 1)

	if err == nil {
		t.Error("expected error for delete op, got nil")
	}
}

func TestTransformTelemetry_NullAfterSkipped(t *testing.T) {
	payload := map[string]any{
		"payload": map[string]any{
			"op":    "c",
			"after": nil,
			"ts_ms": int64(1710662738000),
		},
	}
	raw, _ := json.Marshal(payload)
	_, err := transform.TransformTelemetry(raw, "test.topic", 0, 1)

	if err == nil {
		t.Error("expected error for null after, got nil")
	}
}

func TestTransformTelemetry_MissingDeviceID(t *testing.T) {
	payload := map[string]any{
		"payload": map[string]any{
			"op": "c",
			"after": map[string]any{
				"temperature": 24.5,
			},
			"ts_ms": int64(1710662738000),
		},
	}
	raw, _ := json.Marshal(payload)
	_, err := transform.TransformTelemetry(raw, "test.topic", 0, 1)

	if err == nil {
		t.Error("expected error for missing device_id, got nil")
	}
}

func TestTransformTelemetry_DeterministicEventID(t *testing.T) {
	raw := makeDebeziumEvent("c", "device-123", ptr(20.0), ptr(50.0))

	evt1, _ := transform.TransformTelemetry(raw, "my.topic", 2, 100)
	evt2, _ := transform.TransformTelemetry(raw, "my.topic", 2, 100)

	if evt1.EventID != evt2.EventID {
		t.Errorf("event IDs should be deterministic: %q != %q", evt1.EventID, evt2.EventID)
	}
}

func TestTransformTelemetry_DifferentOffsetsProduceDifferentIDs(t *testing.T) {
	raw := makeDebeziumEvent("c", "device-123", ptr(20.0), ptr(50.0))

	evt1, _ := transform.TransformTelemetry(raw, "my.topic", 0, 100)
	evt2, _ := transform.TransformTelemetry(raw, "my.topic", 0, 101)

	if evt1.EventID == evt2.EventID {
		t.Error("different offsets should produce different event IDs")
	}
}

func TestTransformTelemetry_MissingTemperatureHumidity(t *testing.T) {
	raw := makeDebeziumEvent("c", "device-123", nil, nil)
	evt, err := transform.TransformTelemetry(raw, "test.topic", 0, 1)

	if err != nil {
		t.Fatalf("expected no error for missing temp/humidity, got: %v", err)
	}
	if _, ok := evt.Data["temperature"]; ok {
		t.Error("temperature should not be set when nil")
	}
	if _, ok := evt.Data["humidity"]; ok {
		t.Error("humidity should not be set when nil")
	}
}

func TestMarshalTelemetry_ProducesValidJSON(t *testing.T) {
	raw := makeDebeziumEvent("c", "device-123", ptr(22.0), ptr(60.0))
	evt, _ := transform.TransformTelemetry(raw, "test.topic", 0, 1)

	b, err := transform.MarshalTelemetry(evt)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(b, &result); err != nil {
		t.Fatalf("invalid JSON output: %v", err)
	}
	if result["eventType"] != "telemetry.recorded" {
		t.Errorf("eventType: want telemetry.recorded got %v", result["eventType"])
	}
}
