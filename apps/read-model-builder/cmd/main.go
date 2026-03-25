package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"

	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/consumer"
	"github.com/pahuldeepp/grainguard/apps/read-model-builder/migrations"
	"github.com/pahuldeepp/grainguard/libs/health"
	"github.com/pahuldeepp/grainguard/libs/logger"
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
	exp, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}
	res, err := resource.New(ctx,
		resource.WithAttributes(semconv.ServiceName("read-model-builder")),
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
	logger.Init("read-model-builder")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Redis (cluster or single-node)
	clusterNodes := getenv("REDIS_CLUSTER_NODES", "")
	var addrs []string
	if clusterNodes != "" {
		for _, a := range strings.Split(clusterNodes, ",") {
			addrs = append(addrs, strings.TrimSpace(a))
		}
		log.Info().Int("nodes", len(addrs)).Msg("Redis cluster mode")
	} else {
		addrs = []string{getenv("REDIS_ADDR", "redis:6379")}
		log.Info().Str("addr", addrs[0]).Msg("Redis single-node mode")
	}

	redisClient := redis.NewUniversalClient(&redis.UniversalOptions{
		Addrs:          addrs,
		PoolSize:       getenvInt("REDIS_POOL_SIZE", 20),
		MinIdleConns:   5,
		ReadTimeout:    2 * time.Second,
		WriteTimeout:   2 * time.Second,
		RouteByLatency: len(addrs) > 1,
	})
	defer redisClient.Close()

	if err := redisClient.Ping(ctx).Err(); err != nil {
		log.Warn().Err(err).Msg("redis ping failed (cache best-effort)")
	}

	// Tracing
	shutdown, err := initTracer(ctx)
	if err != nil {
		log.Fatal().Err(err).Msg("otel init failed")
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdown(c)
	}()

	// Metrics
	observability.Init()

	// Database — tuned connection pool
	dbURL := getenv("READ_DB_URL",
		"postgres://postgres:postgres@postgres-read:5432/grainguard_read?sslmode=disable",
	)
	poolConfig, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatal().Err(err).Msg("db config parse failed")
	}
	poolConfig.MaxConns = 25
	poolConfig.MinConns = 5
	poolConfig.MaxConnLifetime = 5 * time.Minute
	poolConfig.MaxConnIdleTime = 1 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		log.Fatal().Err(err).Msg("db connect failed")
	}
	defer pool.Close()

	// Migrations
	if err := libmigrate.Up(dbURL, migrations.FS, "grainguard_read"); err != nil {
		log.Fatal().Err(err).Msg("migration failed")
	}

	// Kafka consumers
	var wg sync.WaitGroup
	workerCount := getenvInt("WORKER_COUNT", 16)

	telemetryConsumer := consumer.NewKafkaConsumerFromEnv("telemetry.events", getenv("KAFKA_GROUP_ID", "read-model-builder"))
	batchHandler := consumer.NewBatchEnvelopeHandler(pool, redisClient)

	log.Info().Int("workers", workerCount).Msg("read-model-builder started with batch workers")
	wg.Add(1)
	go func() {
		defer wg.Done()
		telemetryConsumer.StartBatch(ctx, workerCount, batchHandler)
	}()

	deviceConsumer := consumer.NewKafkaConsumerFromEnv("device.events", "read-model-builder-devices")
	deviceHandler := consumer.NewEnvelopeHandler(pool, redisClient)

	log.Info().Msg("read-model-builder device consumer started")
	wg.Add(1)
	go func() {
		defer wg.Done()
		deviceConsumer.Start(ctx, 4, deviceHandler)
	}()

	// Health check server
	healthHandler := health.NewHandler(
		health.NewPostgresChecker(pool),
		health.NewRedisChecker(redisClient),
		health.NewKafkaChecker(getenv("KAFKA_BROKERS", "kafka:9092")),
	)
	healthSrv := health.NewServer(":8081", healthHandler)
	go func() {
		log.Info().Str("addr", ":8081").Msg("health server listening")
		if err := healthSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error().Err(err).Msg("health server error")
		}
	}()

	// Graceful shutdown
	<-ctx.Done()
	log.Info().Msg("shutting down gracefully")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := healthSrv.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("health server shutdown error")
	}
	log.Info().Msg("health server stopped")

	wg.Wait()
	log.Info().Msg("all consumers drained — exiting")
}

