package domain

import "time"

type Device struct {
	ID           string
	TenantID     string
	SerialNumber string
	Status       string // provisioning | active | detached | failed
	CreatedAt    time.Time
}

type Site struct {
	ID       string
	TenantID string
	Name     string
}
