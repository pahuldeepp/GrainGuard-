package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/application"
	grpcserver "github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/repository"
	devicepb "github.com/pahuldeepp/grainguard/libs/proto"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

func main() {

	ctx := context.Background()

	// 🔹 DATABASE
	dbURL := "postgres://postgres:postgres@localhost:5432/grainguard?sslmode=disable"
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatal("DB connection failed:", err)
	}
	defer pool.Close()

	// 🔹 REPOSITORIES
	deviceRepo := repository.NewPostgresDeviceRepository(pool)
	telemetryRepo := repository.NewPostgresTelemetryRepository(pool)
	outboxRepo := repository.NewPostgresOutboxRepository(pool)

	// 🔹 APPLICATION SERVICES
	createDeviceService := application.NewCreateDeviceService(deviceRepo)
	recordTelemetryService := application.NewRecordTelemetryService(
		pool,
		telemetryRepo,
		outboxRepo,
	)

	// =========================================
	// 🚀 START gRPC SERVER
	// =========================================

	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatal("Failed to listen:", err)
	}

	grpcServer := grpc.NewServer(
		grpc.UnaryInterceptor(otelgrpc.UnaryServerInterceptor()),
	)

	devicepb.RegisterDeviceServiceServer(
		grpcServer,
		grpcserver.NewDeviceServer(createDeviceService),
	)

	go func() {
		log.Println("gRPC server running on :50051")
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatal(err)
		}
	}()

	// =========================================
	// 🌐 START HTTP SERVER
	// =========================================

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
		json.NewEncoder(w).Encode(device)

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

		err := recordTelemetryService.Execute(
			ctx,
			req.DeviceID,
			req.Temperature,
			req.Humidity,
		)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusCreated)

	}).Methods("POST")

	log.Println("HTTP server running on :8080")
	log.Fatal(http.ListenAndServe(":8080", r))
}
