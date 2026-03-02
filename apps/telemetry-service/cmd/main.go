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

	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5/pgxpool"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	devicepb "github.com/pahuldeepp/grainguard/libs/proto"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/application"
	grpcserver "github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc/interceptors"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/repository"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

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
	   🔐 JWT CONFIG (User Identity via OAuth / JWKS)
	======================================================= */

	jwksURL := os.Getenv("JWKS_URL")
	issuer := os.Getenv("JWT_ISSUER")
	audience := os.Getenv("JWT_AUDIENCE")

	if jwksURL == "" || issuer == "" || audience == "" {
		log.Fatal("JWKS_URL / JWT_ISSUER / JWT_AUDIENCE must be set")
	}

	verifier, err := interceptors.NewJWTVerifier(jwksURL, issuer, audience)
	if err != nil {
		log.Fatal("Failed to initialize JWKS verifier:", err)
	}

	/* =======================================================
	   🚀 gRPC SERVER (mTLS + JWT + RBAC + OTel)
	======================================================= */

	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatal("Failed to listen:", err)
	}

	grpcServer := grpc.NewServer(
	grpc.Creds(creds), // ✅ mTLS enforced
	grpc.StatsHandler(otelgrpc.NewServerHandler()), // 3️⃣ tracing
	grpc.ChainUnaryInterceptor(
		verifier.UnaryAuthInterceptor(),     // 1️⃣ authenticate (JWT)
		interceptors.RBACUnaryInterceptor(), // 2️⃣ authorize (RBAC + tenant)
	),
)

	devicepb.RegisterDeviceServiceServer(
		grpcServer,
		grpcserver.NewDeviceServer(createDeviceService),
	)

	go func() {
		log.Println("gRPC server running with mTLS + JWT + RBAC on :50051")
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatal(err)
		}
	}()

	/* =======================================================
	   🌐 HTTP SERVER (DEV ONLY — bypasses gRPC auth)
	   ⚠️ Do NOT use in production
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