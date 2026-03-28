package observability

import (
	"log"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (

	// EVENT PIPELINE METRICS

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

	EventProcessingLatency = prometheus.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "event_processing_latency_seconds",
			Help:    "Latency of processing telemetry events",
			Buckets: prometheus.DefBuckets,
		},
	)

	InflightJobs = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "inflight_jobs",
			Help: "Number of events currently being processed",
		},
	)

	// KAFKA METRICS

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

	// CIRCUIT BREAKER

	CircuitBreakerState = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "circuit_breaker_state",
			Help: "Circuit breaker state: 0=closed, 1=open, 2=half-open",
		},
	)

	// PIPELINE QUEUE DEPTH

	WorkerQueueDepth = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "worker_queue_depth",
			Help: "Number of jobs waiting in worker queue",
		},
	)

	PublishQueueDepth = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "publish_queue_depth",
			Help: "Number of jobs waiting in publish queue",
		},
	)

	CommitQueueDepth = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "commit_queue_depth",
			Help: "Number of messages waiting to commit",
		},
	)

	// PUBLISH METRICS

	PublishSuccess = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "publish_success_total",
			Help: "Total successfully published Kafka events",
		},
	)

	PublishRetry = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "publish_retry_total",
			Help: "Total Kafka publish retry attempts",
		},
	)

	PublishDLQ = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "publish_dlq_total",
			Help: "Total Kafka publish failures sent to DLQ",
		},
	)

	// ERROR METRICS

	WorkerErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "worker_errors_total",
			Help: "Total worker processing errors",
		},
	)

	CommitErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "commit_errors_total",
			Help: "Total Kafka commit errors",
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

		WorkerQueueDepth,
		PublishQueueDepth,
		CommitQueueDepth,

		PublishSuccess,
		PublishRetry,
		PublishDLQ,

		WorkerErrors,
		CommitErrors,
	)

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())

	go func() {
		log.Println("Prometheus metrics exposed on :2112/metrics")

		metricsServer := &http.Server{
			Addr:              ":2112",
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
		}

		err := metricsServer.ListenAndServe()
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("metrics server failed: %v", err)
		}
	}()
}
