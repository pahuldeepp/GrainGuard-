package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

// ── Config ──────────────────────────────────────────────────────────────────

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
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

// ── API Key cache ───────────────────────────────────────────────────────────

type apiKeyEntry struct {
	TenantID string
	KeyID    string
	CachedAt time.Time
}

type apiKeyCache struct {
	mu      sync.RWMutex
	entries map[string]*apiKeyEntry // key_hash → entry
	ttl     time.Duration
}

func newAPIKeyCache(ttl time.Duration) *apiKeyCache {
	return &apiKeyCache{
		entries: make(map[string]*apiKeyEntry, 1024),
		ttl:     ttl,
	}
}

func (c *apiKeyCache) get(keyHash string) (*apiKeyEntry, bool) {
	c.mu.RLock()
	entry, ok := c.entries[keyHash]
	c.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if time.Since(entry.CachedAt) > c.ttl {
		// Re-check under write lock to avoid race between TTL check and delete
		c.mu.Lock()
		entry, ok = c.entries[keyHash]
		if ok && time.Since(entry.CachedAt) > c.ttl {
			delete(c.entries, keyHash)
			c.mu.Unlock()
			return nil, false
		}
		c.mu.Unlock()
		if ok {
			return entry, true
		}
		return nil, false
	}
	return entry, true
}

func (c *apiKeyCache) set(keyHash string, entry *apiKeyEntry) {
	c.mu.Lock()
	c.entries[keyHash] = entry
	c.mu.Unlock()
}

// ── Telemetry payload ───────────────────────────────────────────────────────

type IngestPayload struct {
	SerialNumber string   `json:"serialNumber"`
	Temperature  *float64 `json:"temperature"`
	Humidity     *float64 `json:"humidity"`
	Timestamp    string   `json:"timestamp,omitempty"`
}

// ── Globals ─────────────────────────────────────────────────────────────────

var (
	writer     *kafka.Writer
	db         *pgxpool.Pool
	rdb        *redis.Client
	cache      *apiKeyCache
	ingested   atomic.Int64
	rejected   atomic.Int64
	kafkaTopic string
	bodyPool   = sync.Pool{New: func() any { return make([]byte, 0, 4096) }}
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("ingest-service starting (GOMAXPROCS=%d, CPUs=%d)", runtime.GOMAXPROCS(0), runtime.NumCPU())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// ── Kafka writer ────────────────────────────────────────────────────────
	brokers := strings.Split(getenv("KAFKA_BROKERS", "kafka:9092"), ",")
	kafkaTopic = getenv("KAFKA_TOPIC", "telemetry.ingest")

	writer = &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        kafkaTopic,
		Balancer:     &kafka.LeastBytes{},
		RequiredAcks: kafka.RequireOne,
		BatchSize:    getenvInt("KAFKA_BATCH_SIZE", 200),
		BatchTimeout: time.Duration(getenvInt("KAFKA_BATCH_TIMEOUT_MS", 5)) * time.Millisecond,
		Async:        false, // sync so we can return 500 on failure
	}
	defer writer.Close()

	// ── Postgres pool (for API key lookups) ─────────────────────────────────
	dbURL := getenv("DATABASE_URL", "postgres://postgres:postgres@postgres:5432/grainguard?sslmode=disable")
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatalf("bad DATABASE_URL: %v", err)
	}
	poolCfg.MaxConns = int32(getenvInt("DB_MAX_CONNS", 10))
	poolCfg.MinConns = 2

	db, err = pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		log.Fatalf("Postgres connect error: %v", err)
	}
	defer db.Close()

	// Verify connection
	if err := db.Ping(ctx); err != nil {
		log.Fatalf("Postgres ping failed: %v", err)
	}
	log.Printf("Postgres connected (max_conns=%d)", poolCfg.MaxConns)

	// ── Redis (optional — used for API key caching) ─────────────────────────
	redisAddr := getenv("REDIS_ADDR", "redis:6379")
	rdb = redis.NewClient(&redis.Options{
		Addr:         redisAddr,
		PoolSize:     getenvInt("REDIS_POOL_SIZE", 20),
		MinIdleConns: 5,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
	})
	defer rdb.Close()

	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("Redis not available (continuing without cache): %v", err)
		rdb = nil
	} else {
		log.Printf("Redis connected at %s", redisAddr)
	}

	// ── In-memory API key cache ─────────────────────────────────────────────
	cacheTTL := time.Duration(getenvInt("API_KEY_CACHE_TTL_SECONDS", 300)) * time.Second
	cache = newAPIKeyCache(cacheTTL)

	// ── HTTP server ─────────────────────────────────────────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("/ingest", handleIngest)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/health/ready", handleReady)

	port := getenv("PORT", "3001")
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 16, // 64KB
	}

	// ── Stats ticker ────────────────────────────────────────────────────────
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				log.Printf("stats: ingested=%d rejected=%d goroutines=%d",
					ingested.Load(), rejected.Load(), runtime.NumGoroutine())
			case <-ctx.Done():
				return
			}
		}
	}()

	// ── Start ───────────────────────────────────────────────────────────────
	go func() {
		log.Printf("ingest-service listening on :%s", port)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("Shutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP shutdown error: %v", err)
	}

	log.Printf("ingest-service stopped. total_ingested=%d total_rejected=%d",
		ingested.Load(), rejected.Load())
}

// ── Handlers ────────────────────────────────────────────────────────────────

func handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, `{"error":"method_not_allowed"}`)
		return
	}

	// ── Auth: API key → tenant lookup ───────────────────────────────────────
	apiKey := r.Header.Get("X-Api-Key")
	if apiKey == "" {
		rejected.Add(1)
		writeJSON(w, 401, `{"error":"missing_api_key"}`)
		return
	}

	entry, err := resolveAPIKey(r.Context(), apiKey)
	if err != nil {
		rejected.Add(1)
		log.Printf("[ingest] API key lookup error: %v", err)
		writeJSON(w, 500, `{"error":"internal_error"}`)
		return
	}
	if entry == nil {
		rejected.Add(1)
		writeJSON(w, 401, `{"error":"invalid_api_key"}`)
		return
	}

	// ── Read body ───────────────────────────────────────────────────────────
	buf := bodyPool.Get().([]byte)
	defer func() { bodyPool.Put(buf[:0]) }()

	lr := io.LimitReader(r.Body, 4096)
	n, err := io.ReadFull(lr, buf[:cap(buf)])
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		rejected.Add(1)
		writeJSON(w, 400, `{"error":"bad_request"}`)
		return
	}
	body := buf[:n]

	var payload IngestPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		rejected.Add(1)
		writeJSON(w, 400, `{"error":"invalid_json"}`)
		return
	}

	if payload.SerialNumber == "" {
		rejected.Add(1)
		writeJSON(w, 400, `{"error":"missing_serialNumber"}`)
		return
	}

	// ── Build Kafka envelope ────────────────────────────────────────────────
	eventID := uuid.New().String()
	occurredAt := payload.Timestamp
	if occurredAt == "" {
		occurredAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	envelope, _ := json.Marshal(map[string]any{
		"eventId":     eventID,
		"eventType":   "telemetry.recorded",
		"aggregateId": payload.SerialNumber,
		"occurredAt":  occurredAt,
		"data": map[string]any{
			"deviceId":    payload.SerialNumber,
			"tenantId":    entry.TenantID,
			"temperature": payload.Temperature,
			"humidity":    payload.Humidity,
		},
	})

	// ── Produce to Kafka ────────────────────────────────────────────────────
	err = writer.WriteMessages(r.Context(), kafka.Message{
		Key:   []byte(payload.SerialNumber),
		Value: envelope,
	})
	if err != nil {
		rejected.Add(1)
		log.Printf("[ingest] Kafka write error: %v", err)
		writeJSON(w, 500, `{"error":"ingest_failed"}`)
		return
	}

	ingested.Add(1)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(202)
	fmt.Fprintf(w, `{"accepted":true,"eventId":"%s"}`, eventID)
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, `{"status":"ok","service":"ingest-service"}`)
}

func handleReady(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{}

	if err := db.Ping(r.Context()); err != nil {
		checks["postgres"] = "error"
	} else {
		checks["postgres"] = "ok"
	}

	if rdb != nil {
		if err := rdb.Ping(r.Context()).Err(); err != nil {
			checks["redis"] = "error"
		} else {
			checks["redis"] = "ok"
		}
	}

	allOk := true
	for _, v := range checks {
		if v != "ok" {
			allOk = false
			break
		}
	}

	status := 200
	statusStr := "ok"
	if !allOk {
		status = 503
		statusStr = "degraded"
	}

	resp, _ := json.Marshal(map[string]any{"status": statusStr, "checks": checks})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(resp)
}

// ── API Key resolution (in-memory cache → Redis → Postgres) ─────────────────

func resolveAPIKey(ctx context.Context, rawKey string) (*apiKeyEntry, error) {
	// Hash the key the same way the Gateway does: SHA256 hex
	h := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(h[:])

	// 1. In-memory cache (zero allocation, ~5ns)
	if entry, ok := cache.get(keyHash); ok {
		return entry, nil
	}

	// 2. Redis cache (~0.5ms) — use hash not raw key
	if rdb != nil {
		cached, err := rdb.Get(ctx, "apikey:"+keyHash).Result()
		if err == nil && cached != "" {
			var entry apiKeyEntry
			if json.Unmarshal([]byte(cached), &entry) == nil {
				entry.CachedAt = time.Now()
				cache.set(keyHash, &entry)
				return &entry, nil
			}
		}
	}

	// 3. Postgres (~2-5ms)
	var keyID, tenantID string
	err := db.QueryRow(ctx,
		`SELECT id, tenant_id FROM api_keys
		 WHERE key_hash = $1
		   AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > NOW())
		 LIMIT 1`,
		keyHash,
	).Scan(&keyID, &tenantID)

	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, fmt.Errorf("api key query: %w", err)
	}

	entry := &apiKeyEntry{
		TenantID: tenantID,
		KeyID:    keyID,
		CachedAt: time.Now(),
	}

	// Warm caches
	cache.set(keyHash, entry)
	if rdb != nil {
		data, _ := json.Marshal(map[string]string{"TenantID": tenantID, "KeyID": keyID})
		rdb.Set(ctx, "apikey:"+keyHash, data, 5*time.Minute)
	}

	return entry, nil
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write([]byte(body))
}
