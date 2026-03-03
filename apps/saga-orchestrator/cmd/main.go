package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/consumer"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/orchestrator"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/producer"
	"github.com/pahuldeepp/grainguard/apps/saga-orchestrator/internal/repository"
)

func mustEnv(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}

func main(){
	ctx, stop := signal.NotifyContext(
	context.Background(),
	os.Interrupt,
	syscall.SIGTERM,
)
defer stop()
  
	dbURL := mustEnv("SAGA_DB_URL", "postgres://postgres:postgres@localhost:5432/grainguard?sslmode=disable")
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatal("failed to connect to db:", err)
	}
	defer pool.Close()	
	eventsTopic := mustEnv("SAGA_EVENTS_TOPIC", "device.events")
	groupID := mustEnv("SAGA_CONSUMER_GROUP", "saga-orchestrator")
	commandsTopic := mustEnv("SAGA_COMMANDS_TOPIC", "device.commands")
	consumer := consumer.NewKafkaConsumerFromEnv(eventsTopic, groupID)
	cmdProducer := producer.NewProducerFromEnv(commandsTopic)
	defer cmdProducer.Close()
	repo := repository.NewPostgresSagaRepository(pool)
	provision := orchestrator.NewProvisionSaga(repo, cmdProducer)

	log.Println("saga-orchestrator starting... topic:", eventsTopic)

	go consumer.Start(ctx, func(b []byte) error {
		return provision.HandleEvent(ctx, b)
	})

	<-ctx.Done()
	time.Sleep(300 * time.Millisecond)
	log.Println("saga-orchestrator stopped")

}