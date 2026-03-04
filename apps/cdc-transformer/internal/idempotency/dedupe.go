package idempotency

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

type Deduper struct {
	rdb         *redis.Client
	confirmTTL  time.Duration
	reserveTTL  time.Duration
}

func NewDeduper(rdb *redis.Client, confirmTTL time.Duration) *Deduper {
	return &Deduper{
		rdb:        rdb,
		confirmTTL: confirmTTL,
		reserveTTL: 2 * time.Minute,
	}
}

// Reserve tries to claim the key quickly.
// true => you own it, proceed
// false => duplicate/inflight elsewhere
func (d *Deduper) Reserve(ctx context.Context, key string) (bool, error) {
	return d.rdb.SetNX(ctx, key, "reserved", d.reserveTTL).Result()
}

// Confirm extends TTL after successful publish.
func (d *Deduper) Confirm(ctx context.Context, key string) error {
	return d.rdb.Set(ctx, key, "done", d.confirmTTL).Err()
}

// Cancel removes reservation when publish fails so it can retry.
func (d *Deduper) Cancel(ctx context.Context, key string) error {
	return d.rdb.Del(ctx, key).Err()
}