package observability

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	EventsProcessed = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "events_processed_total",
			Help: "Total successfully processed events",
		},
	)

	EventsDLQ = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "events_dlq_total",
			Help: "Total events sent to DLQ",
		},
	)

	EventsRetry = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "events_retry_total",
			Help: "Total retry attempts",
		},
	)

	// 🔥 NEW: Kafka fetch errors metric
	KafkaFetchErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "kafka_fetch_errors_total",
			Help: "Total Kafka fetch errors",
		},
	)

	CircuitBreakerState = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "circuit_breaker_state",
			Help: "0=closed, 1=open, 2=half-open",
		},
	)

	KafkaConsumerLag = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "kafka_consumer_lag",
			Help: "Current Kafka consumer lag",
		},
	)
)

func Init() {
	prometheus.MustRegister(
		EventsProcessed,
		EventsDLQ,
		EventsRetry,
		KafkaFetchErrors, // 🔥 register new metric
		CircuitBreakerState,
		KafkaConsumerLag,
	)

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		http.ListenAndServe(":2112", nil)
	}()
}