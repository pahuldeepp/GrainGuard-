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
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/consumer"
	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/observability"
	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/projection"
)

func initTracer(ctx context.Context) (func(context.Context) error, error) {
	endpoint := getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317")

	exp, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
	)

	otel.SetTracerProvider(tp)

	return tp.Shutdown, nil
}

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

	// 🔹 Redis (cache layer - best effort)
	redisClient := redis.NewClient(&redis.Options{
		Addr: getenv("REDIS_ADDR", "localhost:6379"),
	})
	defer func() { _ = redisClient.Close() }()

	if err := redisClient.Ping(ctx).Err(); err != nil {
		log.Printf("redis ping failed (cache will be best-effort): %v", err)
	}

	// 🔹 Initialize tracing
	shutdown, err := initTracer(ctx)
	if err != nil {
		log.Fatalf("otel init failed: %v", err)
	}
	defer func() { _ = shutdown(context.Background()) }()

	// 🔹 Initialize metrics
	observability.Init()

	// 🔹 Metrics endpoint
	metricsPort := getenv("METRICS_PORT", "2112")
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		log.Printf("metrics listening on :%s", metricsPort)
		if err := http.ListenAndServe(":"+metricsPort, mux); err != nil {
			log.Printf("metrics server error: %v", err)
		}
	}()

	// 🔹 Database
	dbURL := getenv(
		"READ_DB_URL",
		"postgres://postgres:postgres@postgres-read:5432/grainguard_read?sslmode=disable",
	)
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("db connect failed: %v", err)
	}
	defer pool.Close()

	// 🔹 Kafka consumer (prefer env-based if you have it)
	kafkaConsumer := consumer.NewKafkaConsumerFromEnv()

	// handler now does: Postgres write + best-effort Redis write-through
	handler := projection.HandleTelemetry(pool, redisClient)

	log.Println("Read-model-builder started")

	go kafkaConsumer.Start(ctx, handler)

	<-ctx.Done()

	log.Println("Shutting down gracefully...")
	time.Sleep(2 * time.Second)
}
