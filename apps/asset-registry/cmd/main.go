package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pahuldeepp/grainguard/apps/asset-registry/internal/application"
	assetkafka "github.com/pahuldeepp/grainguard/apps/asset-registry/internal/kafka"
)

func main() {
	brokers := strings.Split(getEnv("KAFKA_BROKERS", "kafka:9092"), ",")
	cmdTopic := getEnv("COMMANDS_TOPIC", "device.commands")
	eventTopic := getEnv("EVENTS_TOPIC", "device.events")
	groupID := getEnv("KAFKA_GROUP_ID", "asset-registry")
	dbURL := getEnv(
		"DATABASE_URL",
		"postgres://postgres:postgres@pgbouncer-write:5432/grainguard?sslmode=disable",
	)

	log.Println("[asset-registry] starting")

	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		log.Fatalf("[asset-registry] db connect failed: %v", err)
	}
	defer pool.Close()

	publisher := assetkafka.NewEventPublisher(brokers, eventTopic)
	handler := application.NewCommandHandler(pool, publisher)
	consumer := assetkafka.NewCommandConsumer(brokers, cmdTopic, groupID, handler)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go consumer.Start(ctx)

	log.Println("[asset-registry] running")

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("[asset-registry] shutting down")
	cancel()
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
