package logger

import (
	"os"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// Init initialises the global zerolog logger for a service.
// Call once in main() before anything else.
//
//	logger.Init("telemetry-service")
func Init(service string) zerolog.Logger {
	zerolog.TimeFieldFormat = time.RFC3339Nano

	// Pretty print in dev, JSON in production
	env := os.Getenv("ENV")
	if env == "" || env == "dev" || env == "local" {
		log.Logger = log.Output(zerolog.ConsoleWriter{
			Out:        os.Stderr,
			TimeFormat: time.RFC3339,
		}).With().Str("service", service).Logger()
	} else {
		log.Logger = zerolog.New(os.Stderr).
			With().
			Timestamp().
			Str("service", service).
			Logger()
	}

	return log.Logger
}

// With returns a logger with extra fields attached.
// Use for request-scoped logging.
//
//	l := logger.With("tenant_id", tenantID, "device_id", deviceID)
//	l.Info().Msg("telemetry recorded")
func With(fields ...any) zerolog.Logger {
	ctx := log.Logger.With()
	for i := 0; i+1 < len(fields); i += 2 {
		key, _ := fields[i].(string)
		ctx = ctx.Interface(key, fields[i+1])
	}
	return ctx.Logger()
}
