package orchestrator

import (
	"fmt"

	"google.golang.org/protobuf/proto"

	eventspb "github.com/pahuldeepp/grainguard/libs/events/gen" // <-- adjust if needed
)

func ParseEnvelope(b []byte)(*eventspb.EventEnvelope, error){
	
	var envelope eventspb.EventEnvelope
	if err := proto.Unmarshal(b, &envelope); err != nil {
		return nil, fmt.Errorf("failed to unmarshal envelope: %w", err)
	}

	return &envelope, nil
}