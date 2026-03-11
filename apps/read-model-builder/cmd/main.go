package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"

	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/consumer"
	"github.com/pahuldeepp/grainguard/apps/read-model-builder/migrations"
	"github.com/pahuldeepp/grainguard/libs/health"
	libmigrate "github.com/pahuldeepp/grainguard/libs/migrate"
	"github.com/pahuldeepp/grainguard/libs/observability"
)

func getenv(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func getenvInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func initTracer(ctx context.Context) (func(context.Context) error, error) {
	endpoint := getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "otel-collector:4317")

	exp, err := otlptracegrpc.New(
		ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}

	res, err := resource.New(
		ctx,
		resource.WithAttributes(
			semconv.ServiceName("read-model-builder"),
		),
	)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return tp.Shutdown, nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	//-----------------------------------
	// Redis
	//-----------------------------------

	redisClient := redis.NewClient(&redis.Options{
		Addr: getenv("REDIS_ADDR", "redis:6379"),
	})
	defer redisClient.Close()

	if err := redisClient.Ping(ctx).Err(); err != nil {
		log.Printf("redis ping failed (cache best-effort): %v", err)
	}

	//-----------------------------------
	// Tracing
	//-----------------------------------

	shutdown, err := initTracer(ctx)
	if err != nil {
		log.Fatalf("otel init failed: %v", err)
	}

	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdown(c)
	}()

	//-----------------------------------
	// Metrics
	//-----------------------------------

	observability.Init()

	//-----------------------------------
	// Database — tuned connection pool
	// MaxConns=25: supports 16 workers + headroom for bursts
	// MinConns=5:  keeps warm connections ready, avoids cold-start latency
	// MaxConnLifetime=5m: recycles connections to avoid stale TCP issues
	// MaxConnIdleTime=1m: cleans up idle connections under low load
	//-----------------------------------

	dbURL := getenv(
		"READ_DB_URL",
		"postgres://postgres:postgres@postgres-read:5432/grainguard_read?sslmode=disable",
	)

	poolConfig, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatalf("db config parse failed: %v", err)
	}
	poolConfig.MaxConns = 25
	poolConfig.MinConns = 5
	poolConfig.MaxConnLifetime = 5 * time.Minute
	poolConfig.MaxConnIdleTime = 1 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		log.Fatalf("db connect failed: %v", err)
	}
	defer pool.Close()

	//-----------------------------------
	// Migrations — run before consumers start
	// Schema must exist before any events try to write to tables.
	// Already-applied migrations are skipped automatically.
	// Embedded via //go:embed so no files needed at runtime.
	//-----------------------------------

	if err := libmigrate.Up(dbURL, migrations.FS, "grainguard_read"); err != nil {
		log.Fatalf("migration failed: %v", err)
	}

	//-----------------------------------
	// Kafka Consumers
	// wg tracks both goroutines so we wait for them to fully
	// drain before exiting — replaces the fragile time.Sleep(2s).
	//-----------------------------------

	var wg sync.WaitGroup
	workerCount := getenvInt("WORKER_COUNT", 16)

	// Consumer 1: telemetry.events — batch mode for high throughput
	// StartBatch uses a 64-event accumulator per worker.
	// Each flush = 1 DB transaction + 1 Redis pipeline instead of 64.
	telemetryConsumer := consumer.NewKafkaConsumerFromEnv(
		"telemetry.events",
		"read-model-builder",
	)
	batchHandler := consumer.NewBatchEnvelopeHandler(pool, redisClient)
	log.Printf("read-model-builder started with %d batch workers", workerCount)
	wg.Add(1)
	go func() {
		defer wg.Done()
		telemetryConsumer.StartBatch(ctx, workerCount, batchHandler)
	}()

	// Consumer 2: device.events — single mode, lower volume
	deviceConsumer := consumer.NewKafkaConsumerFromEnv(
		"device.events",
		"read-model-builder-devices",
	)
	deviceHandler := consumer.NewEnvelopeHandler(pool, redisClient)
	log.Printf("read-model-builder device consumer started")
	wg.Add(1)
	go func() {
		defer wg.Done()
		deviceConsumer.Start(ctx, 4, deviceHandler)
	}()

	//-----------------------------------
	// Health check server
	// :8081 — dedicated port, never shares with app traffic
	// /healthz/live  → liveness  (K8s restarts pod if this fails)
	// /healthz/ready → readiness (K8s stops routing if this fails)
	//-----------------------------------

	healthHandler := health.NewHandler(
		health.NewPostgresChecker(pool),
		health.NewRedisChecker(redisClient),
		health.NewKafkaChecker(getenv("KAFKA_BROKERS", "kafka:9092")),
	)
	healthSrv := health.NewServer(":8081", healthHandler)
	go func() {
		log.Println("health server listening on :8081")
		if err := healthSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("health server error: %v", err)
		}
	}()

	//-----------------------------------
	// Graceful shutdown — order matters:
	// 1. health server stops → K8s sees unready, stops routing new traffic
	// 2. wg.Wait()          → consumers finish their current batch/message
	// 3. defers run         → pool.Close(), redisClient.Close(), OTel flush
	//-----------------------------------

	<-ctx.Done()
	log.Println("shutting down gracefully...")

	// Step 1: stop accepting health probes
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := healthSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("health server shutdown error: %v", err)
	}
	log.Println("health server stopped")

	// Step 2: wait for consumers to finish in-flight batches
	wg.Wait()
	log.Println("all consumers drained, exiting")

	// Step 3: defers above handle pool.Close(), redisClient.Close(), OTel shutdown
}
