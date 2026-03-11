package health

import (
    "context"
    "encoding/json"
    "net/http"
    "time"
)

type Response struct {
    Status string            `json:"status"`
    Checks map[string]string `json:"checks"`
}

type Handler struct {
    checkers []Checker
}

func NewHandler(checkers ...Checker) *Handler {
    return &Handler{checkers: checkers}
}

func (h *Handler) Live(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ok"}`))
}

func (h *Handler) Ready(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
    defer cancel()

    resp := Response{Status: "ok", Checks: make(map[string]string)}

    for _, c := range h.checkers {
        if err := c.Check(ctx); err != nil {
            resp.Status = "degraded"
            resp.Checks[c.Name()] = err.Error()
        } else {
            resp.Checks[c.Name()] = "ok"
        }
    }

    code := http.StatusOK
    if resp.Status == "degraded" {
        code = http.StatusServiceUnavailable
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(code)
    json.NewEncoder(w).Encode(resp)
}

// NewServer wires the routes and returns an *http.Server.   ← ADD THIS FUNCTION
func NewServer(addr string, h *Handler) *http.Server {
    mux := http.NewServeMux()
    mux.HandleFunc("/healthz/live", h.Live)
    mux.HandleFunc("/healthz/ready", h.Ready)
    return &http.Server{Addr: addr, Handler: mux}
}