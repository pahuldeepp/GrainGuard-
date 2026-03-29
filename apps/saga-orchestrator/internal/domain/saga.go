package domain

import "github.com/google/uuid"

type SagaStatus string

const (
	StatusStarted      SagaStatus = "STARTED"
	StatusInProgress   SagaStatus = "IN_PROGRESS"
	StatusCompensating SagaStatus = "COMPENSATING"
	StatusCompleted    SagaStatus = "COMPLETED"
	StatusFailed       SagaStatus = "FAILED"
)

type ProvisionStep string

const (
	StepDeviceCreated  ProvisionStep = "DEVICE_CREATED"
	StepTenantAttached ProvisionStep = "TENANT_ATTACHED"
	StepQuotaAllocated ProvisionStep = "QUOTA_ALLOCATED"
)

type SagaType string

const (
	SagaProvisionDevice SagaType = "PROVISION_DEVICE"
)

type Saga struct {
	ID            uuid.UUID
	Type          SagaType
	CorrelationID string
	Status        SagaStatus
	CurrentStep   string // keep string for DB flexibility
	PayloadJSON   []byte // raw JSON payload stored in DB
	LastError     string
}

var validStatuses = map[SagaStatus]bool{
	StatusStarted:      true,
	StatusInProgress:   true,
	StatusCompensating: true,
	StatusCompleted:    true,
	StatusFailed:       true,
}

// IsValidStatus checks whether a status string is a known SagaStatus.
func IsValidStatus(s SagaStatus) bool {
	return validStatuses[s]
}
