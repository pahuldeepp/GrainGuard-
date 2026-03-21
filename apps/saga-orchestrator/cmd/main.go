package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/consumer"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/orchestrator"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/producer"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/recovery"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/repository"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/migrations"
	"github.com/pahuldeepp/grainguard/libs/health"
	"github.com/pahuldeepp/grainguard/libs/logger"
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
	logger.Init("saga-orchestrator")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dbURL := mustEnv("SAGA_DB_URL", "postgres://postgres:postgres@localhost:5432/grainguard?sslmode=disable")

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to db")
	}
	defer pool.Close()

	if err := libmigrate.Up(dbURL, migrations.FS, "grainguard"); err != nil {
		log.Fatal().Err(err).Msg("migration failed")
	}

	eventsTopic   := mustEnv("SAGA_EVENTS_TOPIC", "device.events")
	groupID       := mustEnv("SAGA_CONSUMER_GROUP", "saga-orchestrator")
	commandsTopic := mustEnv("SAGA_COMMANDS_TOPIC", "device.commands")
	kafkaBrokers  := mustEnv("KAFKA_BROKERS", "kafka:9092")

	kafkaConsumer := consumer.NewKafkaConsumerFromEnv(eventsTopic, groupID)
	cmdProducer   := producer.NewProducerFromEnv(commandsTopic)
	defer cmdProducer.Close()

	repo      := repository.NewPostgresSagaRepository(pool)
	provision := orchestrator.NewProvisionSaga(repo, cmdProducer)

	recoveryWorker := recovery.NewRecoveryWorker(pool, cmdProducer)
	go recoveryWorker.Start(ctx)

	log.Info().
		Str("topic", eventsTopic).
		Str("group_id", groupID).
		Msg("saga-orchestrator starting")

	go kafkaConsumer.Start(ctx, func(handlerCtx context.Context, b []byte) error {
		return provision.HandleEvent(handlerCtx, b)
	})

	healthHandler := health.NewHandler(
		health.NewPostgresChecker(pool),
		health.NewKafkaChecker(kafkaBrokers),
	)
	healthSrv := health.NewServer(":8081", healthHandler)

	go func() {
		log.Info().Str("addr", ":8081").Msg("health server listening")
		if err := healthSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error().Err(err).Msg("health server error")
		}
	}()

	<-ctx.Done()
	log.Info().Msg("shutting down gracefully")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := healthSrv.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("health server shutdown error")
	}

	log.Info().Msg("saga-orchestrator stopped")
}

