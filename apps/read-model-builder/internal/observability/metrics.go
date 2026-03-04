package observability

import (
	"log"
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
			Help: "Total events sent to dead letter queue",
		},
	)

	EventsRetry = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "events_retry_total",
			Help: "Total retry attempts",
		},
	)

	KafkaFetchErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "kafka_fetch_errors_total",
			Help: "Total Kafka fetch errors",
		},
	)

	KafkaConsumerLag = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "kafka_consumer_lag",
			Help: "Current Kafka consumer lag",
		},
	)

	InflightJobs = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "inflight_jobs",
			Help: "Number of events currently being processed",
		},
	)

	CircuitBreakerState = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "circuit_breaker_state",
			Help: "Circuit breaker state: 0=closed, 1=open, 2=half-open",
		},
	)

	EventProcessingLatency = prometheus.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "event_processing_latency_seconds",
			Help:    "Latency of processing telemetry events",
			Buckets: prometheus.DefBuckets,
		},
	)
)

func Init() {

	prometheus.MustRegister(
		EventsProcessed,
		EventsDLQ,
		EventsRetry,
		KafkaFetchErrors,
		KafkaConsumerLag,
		InflightJobs,
		CircuitBreakerState,
		EventProcessingLatency,
	)

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())

	go func() {
		log.Println("Prometheus metrics exposed on :2112/metrics")

		err := http.ListenAndServe(":2112", mux)
		if err != nil {
			log.Fatalf("metrics server failed: %v", err)
		}
	}()
}