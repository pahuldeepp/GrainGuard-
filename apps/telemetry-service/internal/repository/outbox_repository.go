package repository

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type OutboxRepository interface {
	Insert(ctx context.Context, tx pgx.Tx, aggregateType, aggregateID, eventType string, payload []byte) error
}
