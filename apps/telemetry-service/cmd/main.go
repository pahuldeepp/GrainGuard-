package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5/pgxpool"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	devicepb "github.com/pahuldeepp/grainguard/libs/proto"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/application"
	grpcserver "github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc/interceptors"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/repository"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/migrations"
	"github.com/pahuldeepp/grainguard/libs/health"
	libmigrate "github.com/pahuldeepp/grainguard/libs/migrate"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

func envBool(key string, def bool) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if v == "" {
		return def
	}
	return v == "true" || v == "1" || v == "yes" || v == "y"
}

func main() {
	ctx := context.Background()

	/* =======================================================
	   🔐 mTLS CONFIGURATION (Service Identity)
	======================================================= */

	serverCert, err := tls.LoadX509KeyPair(
		"/certs/telemetry-server.crt",
		"/certs/telemetry-server.key",
	)
	if err != nil {
		log.Fatal("Failed to load server certificate:", err)
	}

	caCert, err := os.ReadFile("/certs/ca.crt")
	if err != nil {
		log.Fatal("Failed to read CA certificate:", err)
	}

	certPool := x509.NewCertPool()
	if !certPool.AppendCertsFromPEM(caCert) {
		log.Fatal("Failed to append CA certificate")
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientCAs:    certPool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS13,
	}

	creds := credentials.NewTLS(tlsConfig)

	/* =======================================================
	   🗄️ DATABASE
	======================================================= */

	dbURL := os.Getenv("WRITE_DB_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres:postgres@postgres:5432/grainguard?sslmode=disable"
	}

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatal("DB connection failed:", err)
	}
	defer pool.Close()

	/* =======================================================
	   📦 MIGRATIONS — run before anything else touches the DB
	   Schema must exist before repositories are used.
	   Already-applied migrations are skipped automatically.
	   Embedded via //go:embed so no files needed at runtime.
	======================================================= */

	if err := libmigrate.Up(dbURL, migrations.FS, "grainguard"); err != nil {
		log.Fatalf("migration failed: %v", err)
	}

	/* =======================================================
	   📦 REPOSITORIES
	======================================================= */

	deviceRepo := repository.NewPostgresDeviceRepository(pool)
	telemetryRepo := repository.NewPostgresTelemetryRepository(pool)
	outboxRepo := repository.NewPostgresOutboxRepository(pool)

	/* =======================================================
	   🧠 APPLICATION SERVICES
	======================================================= */

	createDeviceService := application.NewCreateDeviceService(deviceRepo)
	recordTelemetryService := application.NewRecordTelemetryService(
		pool,
		telemetryRepo,
		outboxRepo,
	)

	/* =======================================================
	   🔑 JWT CONFIG (User Identity via OAuth / JWKS)
	   ✅ Toggle with AUTH_ENABLED
	======================================================= */

	authEnabled := envBool("AUTH_ENABLED", false) // default OFF for local

	var jwtVerifier *interceptors.JWTVerifier
	if authEnabled {
		jwksURL := os.Getenv("JWKS_URL")
		issuer := os.Getenv("JWT_ISSUER")
		audience := os.Getenv("JWT_AUDIENCE")

		if jwksURL == "" || issuer == "" || audience == "" {
			log.Fatal("AUTH_ENABLED=true but JWKS_URL / JWT_ISSUER / JWT_AUDIENCE not set")
		}

		v, err := interceptors.NewJWTVerifier(jwksURL, issuer, audience)
		if err != nil {
			log.Fatal("Failed to initialize JWKS verifier:", err)
		}
		jwtVerifier = v
		log.Println("Authentication ENABLED (JWT + RBAC)")
	} else {
		log.Println("Authentication DISABLED (skipping JWKS/JWT/RBAC)")
	}

	/* =======================================================
	   🚀 gRPC SERVER (mTLS + optional JWT/RBAC + OTel)
	======================================================= */

	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatal("Failed to listen:", err)
	}

	var grpcServer *grpc.Server

	if authEnabled && jwtVerifier != nil {
		grpcServer = grpc.NewServer(
			grpc.Creds(creds),                                    // ✅ mTLS enforced
			grpc.StatsHandler(otelgrpc.NewServerHandler()),       // ✅ tracing
			grpc.ChainUnaryInterceptor(
				jwtVerifier.UnaryAuthInterceptor(), // ✅ JWT auth
				interceptors.RBACUnaryInterceptor(), // ✅ RBAC
			),
		)
	} else {
		grpcServer = grpc.NewServer(
			grpc.Creds(creds),                              // ✅ still mTLS
			grpc.StatsHandler(otelgrpc.NewServerHandler()), // ✅ still tracing
			// no JWT / RBAC interceptors
		)
	}

	devicepb.RegisterDeviceServiceServer(
		grpcServer,
		grpcserver.NewDeviceServer(createDeviceService),
	)

	go func() {
		log.Println("gRPC server running on :50051 (mTLS enforced)")
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatal(err)
		}
	}()

	/* =======================================================
	   🏥 HEALTH CHECK SERVER
	   :8081 — dedicated port for K8s liveness/readiness probes
	   /healthz/live  → liveness  (K8s restarts pod if this fails)
	   /healthz/ready → readiness (K8s stops routing if this fails)
	======================================================= */

	healthHandler := health.NewHandler(
		health.NewPostgresChecker(pool),
	)
	healthSrv := health.NewServer(":8081", healthHandler)
	go func() {
		log.Println("health server listening on :8081")
		if err := healthSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("health server error: %v", err)
		}
	}()

	/* =======================================================
	   🌐 HTTP SERVER (DEV ONLY — bypasses gRPC auth)
	======================================================= */

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

		if err := recordTelemetryService.Execute(
			ctx,
			req.DeviceID,
			req.Temperature,
			req.Humidity,
		); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusCreated)
	}).Methods("POST")

	log.Println("HTTP server running on :8080 (DEV ONLY)")
	log.Fatal(http.ListenAndServe(":8080", r))
}

