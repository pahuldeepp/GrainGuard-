package orchestrator

import (
	"encoding/json"
	"fmt"
	"time"

	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen"
)

type legacyDevicePayload struct {
	DeviceID    string `json:"device_id"`
	DeviceIDAlt string `json:"deviceId"`
	TenantID    string `json:"tenant_id"`
	TenantIDAlt string `json:"tenantId"`
	Serial      string `json:"serial"`
	CreatedAt   string `json:"created_at"`
}

type legacyEnvelope struct {
	EventID          string              `json:"event_id"`
	EventIDAlt       string              `json:"eventId"`
	EventType        string              `json:"event_type"`
	EventTypeAlt     string              `json:"eventType"`
	AggregateID      string              `json:"aggregate_id"`
	AggregateIDAlt   string              `json:"aggregateId"`
	TenantID         string              `json:"tenant_id"`
	TenantIDAlt      string              `json:"tenantId"`
	OccurredAtUnixMs int64               `json:"occurred_at_unix_ms"`
	OccurredAt       string              `json:"occurredAt"`
	Payload          legacyDevicePayload `json:"payload"`
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func parseOccurredAtUnixMs(occurredAt string, occurredAtUnixMs int64) int64 {
	if occurredAtUnixMs > 0 {
		return occurredAtUnixMs
	}
	if occurredAt == "" {
		return time.Now().UTC().UnixMilli()
	}
	if parsed, err := time.Parse(time.RFC3339Nano, occurredAt); err == nil {
		return parsed.UTC().UnixMilli()
	}
	if parsed, err := time.Parse(time.RFC3339, occurredAt); err == nil {
		return parsed.UTC().UnixMilli()
	}
	return time.Now().UTC().UnixMilli()
}

func ParseEnvelope(b []byte) (*eventspb.EventEnvelope, error) {
	var envelope eventspb.EventEnvelope
	if err := proto.Unmarshal(b, &envelope); err == nil {
		return &envelope, nil
	}

	var legacy legacyEnvelope
	if err := json.Unmarshal(b, &legacy); err != nil {
		return nil, fmt.Errorf("failed to decode envelope: %w", err)
	}

	eventType := firstNonEmpty(legacy.EventType, legacy.EventTypeAlt)
	if eventType == "" {
		return nil, fmt.Errorf("failed to decode envelope: missing event type")
	}

	aggregateID := firstNonEmpty(
		legacy.AggregateID,
		legacy.AggregateIDAlt,
		legacy.Payload.DeviceID,
		legacy.Payload.DeviceIDAlt,
	)
	tenantID := firstNonEmpty(
		legacy.TenantID,
		legacy.TenantIDAlt,
		legacy.Payload.TenantID,
		legacy.Payload.TenantIDAlt,
	)

	envelope.EventId = firstNonEmpty(legacy.EventID, legacy.EventIDAlt, aggregateID+":"+eventType)
	envelope.EventType = eventType
	envelope.SchemaVersion = 1
	envelope.AggregateId = aggregateID
	envelope.TenantId = tenantID
	envelope.OccurredAtUnixMs = parseOccurredAtUnixMs(legacy.OccurredAt, legacy.OccurredAtUnixMs)

	if eventType == "device_created_v1" {
		envelope.Payload = &eventspb.EventEnvelope_DeviceCreatedV1{
			DeviceCreatedV1: &eventspb.DeviceCreatedV1{
				DeviceId:  firstNonEmpty(legacy.Payload.DeviceID, legacy.Payload.DeviceIDAlt, aggregateID),
				TenantId:  firstNonEmpty(legacy.Payload.TenantID, legacy.Payload.TenantIDAlt, tenantID),
				Serial:    legacy.Payload.Serial,
				CreatedAt: legacy.Payload.CreatedAt,
			},
		}
	}

	return &envelope, nil
}
