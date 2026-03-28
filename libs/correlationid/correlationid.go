package correlationid

import "context"

type contextKey struct{}

// WithContext returns a new context carrying the given correlation ID.
func WithContext(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, contextKey{}, id)
}

// FromContext extracts the correlation ID from the context.
// Returns empty string if not set.
func FromContext(ctx context.Context) string {
	id, _ := ctx.Value(contextKey{}).(string)
	return id
}
