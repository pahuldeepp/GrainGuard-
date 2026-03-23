package health

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Checker interface {
	Name() string
	Check(ctx context.Context) error
}
type postgresChecker struct{ pool *pgxpool.Pool }

func NewPostgresChecker(pool *pgxpool.Pool) Checker { return &postgresChecker{pool} }
func (c *postgresChecker) Name() string             { return "postgres" }
func (c *postgresChecker) Check(ctx context.Context) error { return c.pool.Ping(ctx) }
type redisChecker struct{ client *redis.Client }

func NewRedisChecker(client *redis.Client) Checker { return &redisChecker{client} }
func (c *redisChecker) Name() string               { return "redis" }
func (c *redisChecker) Check(ctx context.Context) error {
	return c.client.Ping(ctx).Err()
}

// ─── Kafka checker ────────────────────────────────────────────────────────────
// kafka-go has no Ping(), so we do a TCP dial to the broker.
// Fast, catches broker-down, no message produced.

type kafkaChecker struct{ addr string }

func NewKafkaChecker(brokerAddr string) Checker { return &kafkaChecker{brokerAddr} }
func (c *kafkaChecker) Name() string            { return "kafka" }
func (c *kafkaChecker) Check(ctx context.Context) error {
	d := &net.Dialer{}
	conn, err := d.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		return fmt.Errorf("dial kafka %s: %w", c.addr, err)
	}
	conn.Close()
	return nil
}

// ─── Handler ──────────────────────────────────────────────────────────────────

type response struct {
	Status string            `json:"status"`         // "ok" or "degraded"
	Checks map[string]string `json:"checks"`         // dep name → "ok" or error msg
}

type Handler struct{ checkers []Checker }

func NewHandler(checkers ...Checker) *Handler {
	return &Handler{checkers: checkers}
}
func (h *Handler) Live(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// Ready → /healthz/ready
// Readiness probe: can this pod accept traffic right now?
// K8s stops routing to this pod (no restart) until it passes again.
// All checkers run in parallel for minimum latency.
func (h *Handler) Ready(w http.ResponseWriter, r *http.Request) {
	// 3s timeout — never let a hung dep block the probe forever
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	type checkResult struct {
		name string
		err  error
	}

	results := make([]checkResult, len(h.checkers))
	var wg sync.WaitGroup

	for i, c := range h.checkers {
		wg.Add(1)
		go func(idx int, checker Checker) {
			defer wg.Done()
			results[idx] = checkResult{
				name: checker.Name(),
				err:  checker.Check(ctx),
			}
		}(i, c)
	}

	wg.Wait()

	resp := response{Status: "ok", Checks: make(map[string]string)}
	for _, r := range results {
		if r.err != nil {
			resp.Status = "degraded"
			resp.Checks[r.name] = r.err.Error()
		} else {
			resp.Checks[r.name] = "ok"
		}
	}

	code := http.StatusOK
	if resp.Status == "degraded" {
		code = http.StatusServiceUnavailable // 503 — K8s removes pod from LB
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(resp)
}

// NewServer builds a ready-to-run HTTP server on the given addr (e.g. ":8081").
// Call go server.ListenAndServe() in main.
func NewServer(addr string, h *Handler) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz/live", h.Live)
	mux.HandleFunc("/healthz/ready", h.Ready)
	return &http.Server{Addr: addr, Handler: mux}
}
