package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/consumer"
	"github.com/pahuldeepp/grainguard/apps/cdc-transformer/internal/idempotency"
)

func getenv(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Redis for dedupe (required for idempotency)
	redisClient := redis.NewClient(&redis.Options{
		Addr: getenv("REDIS_ADDR", "redis:6379"),
	})
	defer redisClient.Close()

	if err := redisClient.Ping(ctx).Err(); err != nil {
		log.Fatalf("redis not reachable (dedupe required): %v", err)
	}

	ttl := 24 * time.Hour
	deduper := idempotency.NewDeduper(redisClient, ttl)

	c := consumer.NewFromEnv(deduper)
	defer c.Close()

	log.Println("cdc-transformer started (idempotent)")
	c.Start(ctx)
}