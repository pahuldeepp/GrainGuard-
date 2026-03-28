package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/consumer"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/orchestrator"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/producer"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/recovery"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/repository"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/migrations"
	"github.com/pahuldeepp/grainguard/libs/health"
	libmigrate "github.com/pahuldeepp/grainguard/libs/migrate"
)

func mustEnv(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}

func main() {
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	dbURL := mustEnv(
		"SAGA_DB_URL",
		"postgres://postgres:postgres@localhost:5432/grainguard?sslmode=disable",
	)

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatal("failed to connect to db:", err)
	}
	defer pool.Close()

	if err := libmigrate.Up(dbURL, migrations.FS, "saga_orchestrator"); err != nil {
		log.Fatalf("migration failed: %v", err)
	}

	eventsTopic := mustEnv("SAGA_EVENTS_TOPIC", "device.events")
	groupID := mustEnv("SAGA_CONSUMER_GROUP", "saga-orchestrator")
	commandsTopic := mustEnv("SAGA_COMMANDS_TOPIC", "device.commands")

	kafkaConsumer := consumer.NewKafkaConsumerFromEnv(eventsTopic, groupID)
	cmdProducer := producer.NewProducerFromEnv(commandsTopic)
	defer cmdProducer.Close()

	repo := repository.NewPostgresSagaRepository(pool)
	provision := orchestrator.NewProvisionSaga(repo, cmdProducer)

	recoveryWorker := recovery.NewRecoveryWorker(pool, cmdProducer)
	go recoveryWorker.Start(ctx)

	log.Println("saga-orchestrator starting... topic:", eventsTopic)

	go kafkaConsumer.Start(ctx, func(handlerCtx context.Context, b []byte) error {
		return provision.HandleEvent(handlerCtx, b)
	})

	healthHandler := health.NewHandler(
		health.NewPostgresChecker(pool),
		health.NewKafkaChecker(mustEnv("KAFKA_BROKERS", "kafka:9092")),
	)
	healthSrv := health.NewServer(":8081", healthHandler)
	go func() {
		log.Println("health server listening on :8081")
		if err := healthSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("health server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down gracefully...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := healthSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("health server shutdown error: %v", err)
	}
	log.Println("health server stopped")

	time.Sleep(300 * time.Millisecond)
	log.Println("saga-orchestrator stopped")
}
