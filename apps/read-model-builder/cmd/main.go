package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
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
	// Kafka Consumer — batch mode
	// StartBatch uses a 64-event accumulator per worker.
	// Each flush = 1 DB transaction + 1 Redis pipeline instead of 64.
	//-----------------------------------

	kafkaConsumer := consumer.NewKafkaConsumerFromEnv(
		"telemetry.events",
		"read-model-builder",
	)

	batchHandler := consumer.NewBatchEnvelopeHandler(pool, redisClient)
	workerCount := getenvInt("WORKER_COUNT", 16)

	log.Printf("read-model-builder started with %d batch workers", workerCount)

	go kafkaConsumer.StartBatch(ctx, workerCount, batchHandler)

	//-----------------------------------
	// Graceful shutdown
	//-----------------------------------

	<-ctx.Done()

	log.Println("shutting down gracefully...")
	time.Sleep(2 * time.Second)
}
