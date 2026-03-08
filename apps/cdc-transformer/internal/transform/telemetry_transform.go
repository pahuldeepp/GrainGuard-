package transform

import (
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
)

type DebeziumEnvelope struct {
	Schema  json.RawMessage `json:"schema,omitempty"`
	Payload DebeziumPayload `json:"payload"`

	// fallback for schemaless payloads
	Before json.RawMessage `json:"before,omitempty"`
	After  json.RawMessage `json:"after,omitempty"`
	Op     string          `json:"op,omitempty"`
	TsMs   int64           `json:"ts_ms,omitempty"`
}

type DebeziumPayload struct {
	Before json.RawMessage `json:"before"`
	After  json.RawMessage `json:"after"`
	Op     string          `json:"op"`
	TsMs   int64           `json:"ts_ms"`
}

type TelemetryAfter struct {
	ID          string   `json:"id"`
	DeviceID    string   `json:"device_id"`
	Temperature *float64 `json:"temperature"`
	Humidity    *float64 `json:"humidity"`
	RecordedAt  string   `json:"recorded_at"`
	CreatedAt   string   `json:"created_at"`
	OccurredAt  string   `json:"occurred_at"`
	TenantID    string   `json:"tenant_id"`
}

type DomainTelemetryRecorded struct {
	EventID     string         `json:"eventId"`
	EventType   string         `json:"eventType"`
	AggregateID string         `json:"aggregateId"`
	OccurredAt  string         `json:"occurredAt"`
	Data        map[string]any `json:"data"`
}

func TransformTelemetry(raw []byte, topic string, partition int, offset int64) (*DomainTelemetryRecorded, error) {
	var env DebeziumEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}

	op := env.Payload.Op
	after := env.Payload.After
	tsMs := env.Payload.TsMs

	// support schemaless debezium too
	if op == "" {
		op = env.Op
	}
	if len(after) == 0 {
		after = env.After
	}
	if tsMs == 0 {
		tsMs = env.TsMs
	}

	// process inserts + updates only
	if op != "c" && op != "u" && op != "r" {
		return nil, errors.New("skip: op not c/u/r")
	}

	if len(after) == 0 || string(after) == "null" {
		return nil, errors.New("skip: missing after")
	}

	var row TelemetryAfter
	if err := json.Unmarshal(after, &row); err != nil {
		return nil, err
	}

	if row.DeviceID == "" {
		return nil, errors.New("missing device_id")
	}

	occurredAt := normalizeTime(pickTime(row, tsMs))

	data := map[string]any{
		"deviceId": row.DeviceID,
	}

	if row.ID != "" {
		data["id"] = row.ID
	}
	if row.Temperature != nil {
		data["temperature"] = *row.Temperature
	}
	if row.Humidity != nil {
		data["humidity"] = *row.Humidity
	}
	if row.TenantID != "" {
		data["tenantId"] = row.TenantID
	}

	return &DomainTelemetryRecorded{
		EventID:     deterministicEventID(topic, partition, offset),
		EventType:   "telemetry.recorded",
		AggregateID: row.DeviceID,
		OccurredAt:  occurredAt,
		Data:        data,
	}, nil
}

func MarshalTelemetry(evt *DomainTelemetryRecorded) ([]byte, error) {
	return json.Marshal(evt)
}

func deterministicEventID(topic string, partition int, offset int64) string {
	input := topic + ":" + strconv.Itoa(partition) + ":" + strconv.FormatInt(offset, 10)
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(input)).String()
}

func pickTime(after TelemetryAfter, tsMs int64) string {
	for _, s := range []string{
		after.RecordedAt,
		after.OccurredAt,
		after.CreatedAt,
	} {
		if s != "" {
			return s
		}
	}

	if tsMs > 0 {
		return time.UnixMilli(tsMs).UTC().Format(time.RFC3339Nano)
	}

	return time.Now().UTC().Format(time.RFC3339Nano)
}

func normalizeTime(t string) string {
	if parsed, err := time.Parse(time.RFC3339Nano, t); err == nil {
		return parsed.UTC().Format(time.RFC3339Nano)
	}
	if parsed, err := time.Parse(time.RFC3339, t); err == nil {
		return parsed.UTC().Format(time.RFC3339Nano)
	}
	if parsed, err := time.Parse("2006-01-02 15:04:05.999999-07", t); err == nil {
		return parsed.UTC().Format(time.RFC3339Nano)
	}
	if parsed, err := time.Parse("2006-01-02 15:04:05.999999", t); err == nil {
		return parsed.UTC().Format(time.RFC3339Nano)
	}

	return time.Now().UTC().Format(time.RFC3339Nano)
}