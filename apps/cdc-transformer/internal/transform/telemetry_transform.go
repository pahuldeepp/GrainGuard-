package transform

import (
	"encoding/json"
	"errors"
	"time"
)

type DebeziumEnvelope struct {
	Payload DebeziumPayload `json:"payload"`
}

type DebeziumPayload struct {
	Before json.RawMessage `json:"before"`
	After  json.RawMessage `json:"after"`
	Op     string          `json:"op"`    // c,u,d,r
	TsMs   int64           `json:"ts_ms"` // event time
}

type TelemetryAfter struct {
	DeviceID     string   `json:"device_id"`
	Temperature  *float64 `json:"temperature"`
	Humidity     *float64 `json:"humidity"`
	RecordedAt   string   `json:"recorded_at"`   // if your table has it
	CreatedAt    string   `json:"created_at"`    // fallback if your table has it
	OccurredAt   string   `json:"occurred_at"`   // fallback if you store it
	TenantID     string   `json:"tenant_id"`     // optional
}
type DomainTelemetryRecorded struct {
	EventType  string                 `json:"eventType"`
	AggregateID string                `json:"aggregateId"` // device id
	OccurredAt string                 `json:"occurredAt"`
	Data       map[string]any         `json:"data"`
}
func TransformTelemetry(raw []byte) (*DomainTelemetryRecorded, error) {
	var env DebeziumEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	// only create/insert or update events become “recorded”
	if env.Payload.Op != "c" && env.Payload.Op != "u" {
		return nil, errors.New("skip: op not c/u")
	}

	if len(env.Payload.After) == 0 || string(env.Payload.After) == "null" {
		return nil, errors.New("skip: missing after")
	}

	var after TelemetryAfter
	if err := json.Unmarshal(env.Payload.After, &after); err != nil {
		return nil, err
	}

	if after.DeviceID == "" {
		return nil, errors.New("missing device_id")
	}

	occurredAt := pickTime(after, env.Payload.TsMs)

	data := map[string]any{
		"deviceId": after.DeviceID,
	}
	if after.Temperature != nil {
		data["temperature"] = *after.Temperature
	}
	if after.Humidity != nil {
		data["humidity"] = *after.Humidity
	}
	if after.TenantID != "" {
		data["tenantId"] = after.TenantID
	}

	return &DomainTelemetryRecorded{
		EventType:   "telemetry.recorded",
		AggregateID: after.DeviceID,
		OccurredAt:  occurredAt,
		Data:        data,
	}, nil
}
func pickTime(after TelemetryAfter, tsMs int64) string {
	// prefer table timestamps if present
	for _, s := range []string{after.RecordedAt, after.OccurredAt, after.CreatedAt} {
		if s != "" {
			// assume it’s already ISO string
			return s
		}
	}
	// fallback to Debezium ts_ms
	if tsMs > 0 {
		return time.UnixMilli(tsMs).UTC().Format(time.RFC3339Nano)
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}