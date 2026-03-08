package events

import "encoding/json"

type Envelope struct {
	EventID     string          `json:"eventId"`
	EventType   string          `json:"eventType"`
	AggregateID string          `json:"aggregateId"`
	OccurredAt  string          `json:"occurredAt"`
	Data        json.RawMessage `json:"data"`
}