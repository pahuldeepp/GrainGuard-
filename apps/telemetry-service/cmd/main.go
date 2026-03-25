package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"

	devicepb "github.com/pahuldeepp/grainguard/libs/proto"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/application"
	grpcserver "github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc/interceptors"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/repository"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/worker"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/migrations"
	"github.com/pahuldeepp/grainguard/libs/health"
	"github.com/pahuldeepp/grainguard/libs/logger"
	libmigrate "github.com/pahuldeepp/grainguard/libs/migrate"
)

func envBool(key string, def bool) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if v == "" {
		return def
	}
	return v == "true" || v == "1" || v == "yes" || v == "y"
}

func main() {
	logger.Init("telemetry-service")

	ctx := context.Background()

	// mTLS
	serverCert, err := tls.LoadX509KeyPair("/certs/telemetry-server.crt", "/certs/telemetry-server.key")
	if err != nil {
		log.Fatal().Err(err).Msg("failed to load server certificate")
	}

	caCert, err := os.ReadFile("/certs/ca.crt")
	if err != nil {
		log.Fatal().Err(err).Msg("failed to read CA certificate")
	}

	certPool := x509.NewCertPool()
	if !certPool.AppendCertsFromPEM(caCert) {
		log.Fatal().Msg("failed to append CA certificate")
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientCAs:    certPool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS13,
	}
	creds := credentials.NewTLS(tlsConfig)

	// Database
	dbURL := os.Getenv("WRITE_DB_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres:postgres@postgres:5432/grainguard?sslmode=disable"
	}

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatal().Err(err).Msg("DB connection failed")
	}
	defer pool.Close()

	// Migrations
	if err := libmigrate.Up(dbURL, migrations.FS, "grainguard"); err != nil {
		log.Fatal().Err(err).Msg("migration failed")
	}

	// Repositories
	deviceRepo    := repository.NewPostgresDeviceRepository(pool)
	telemetryRepo := repository.NewPostgresTelemetryRepository(pool)
	outboxRepo    := repository.NewPostgresOutboxRepository(pool)

	// Outbox relay worker
	outboxWorker := worker.NewOutboxWorker(pool)
	go outboxWorker.Start(ctx)

	// Application services
	createDeviceService    := application.NewCreateDeviceService(pool, deviceRepo, outboxRepo)
	recordTelemetryService := application.NewRecordTelemetryService(pool, telemetryRepo, outboxRepo)

	// Auth
	authEnabled := envBool("AUTH_ENABLED", false)

	var jwtVerifier *interceptors.JWTVerifier
	if authEnabled {
		jwksURL  := os.Getenv("JWKS_URL")
		issuer   := os.Getenv("JWT_ISSUER")
		audience := os.Getenv("JWT_AUDIENCE")

		if jwksURL == "" || issuer == "" || audience == "" {
			log.Fatal().Msg("AUTH_ENABLED=true but JWKS_URL / JWT_ISSUER / JWT_AUDIENCE not set")
		}

		v, err := interceptors.NewJWTVerifier(jwksURL, issuer, audience)
		if err != nil {
			log.Fatal().Err(err).Msg("failed to initialize JWKS verifier")
		}
		jwtVerifier = v
		log.Info().Msg("authentication ENABLED (JWT + RBAC)")
	} else {
		log.Info().Msg("authentication DISABLED (skipping JWKS/JWT/RBAC)")
	}

	// gRPC server
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatal().Err(err).Msg("failed to listen on :50051")
	}

	var grpcServer *grpc.Server
	if authEnabled && jwtVerifier != nil {
		grpcServer = grpc.NewServer(
			grpc.Creds(creds),
			grpc.StatsHandler(otelgrpc.NewServerHandler()),
			grpc.ChainUnaryInterceptor(
				jwtVerifier.UnaryAuthInterceptor(),
				interceptors.RBACUnaryInterceptor(),
			),
		)
	} else {
		grpcServer = grpc.NewServer(
			grpc.Creds(creds),
			grpc.StatsHandler(otelgrpc.NewServerHandler()),
		)
	}

	devicepb.RegisterDeviceServiceServer(grpcServer, grpcserver.NewDeviceServer(createDeviceService))

	go func() {
		log.Info().Str("addr", ":50051").Msg("gRPC server running (mTLS enforced)")
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatal().Err(err).Msg("gRPC server failed")
		}
	}()

	// Health check server
	healthHandler := health.NewHandler(health.NewPostgresChecker(pool))
	healthSrv := health.NewServer(":8081", healthHandler)
	go func() {
		log.Info().Str("addr", ":8081").Msg("health server listening")
		if err := healthSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error().Err(err).Msg("health server error")
		}
	}()

	// HTTP server (dev only)
	r := mux.NewRouter()

	r.HandleFunc("/devices", func(w http.ResponseWriter, r *http.Request) {
		type Request struct {
			TenantID string `json:"tenant_id"`
			Serial   string `json:"serial"`
		}
		var req Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		device, err := createDeviceService.Execute(ctx, req.TenantID, req.Serial)
		if err != nil {
			log.Error().Err(err).Str("tenant_id", req.TenantID).Msg("create device failed")
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(device)
	}).Methods("POST")

	r.HandleFunc("/telemetry", func(w http.ResponseWriter, r *http.Request) {
		type Request struct {
			DeviceID    string  `json:"device_id"`
			Temperature float64 `json:"temperature"`
			Humidity    float64 `json:"humidity"`
		}
		var req Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := recordTelemetryService.Execute(ctx, req.DeviceID, req.Temperature, req.Humidity); err != nil {
			log.Error().Err(err).Str("device_id", req.DeviceID).Msg("record telemetry failed")
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}).Methods("POST")

	log.Info().Str("addr", ":8080").Msg("HTTP server running (DEV ONLY)")
	if err := http.ListenAndServe(":8080", r); err != nil {
		log.Fatal().Err(err).Msg("HTTP server failed")
	}
}

