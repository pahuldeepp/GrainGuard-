package interceptors

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	"github.com/pahuldeepp/grainguard/libs/correlationid"
)

// CorrelationUnaryInterceptor extracts x-request-id from gRPC incoming metadata
// and injects it into the context so downstream handlers can log it.
func CorrelationUnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		_ *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		if md, ok := metadata.FromIncomingContext(ctx); ok {
			if vals := md.Get("x-request-id"); len(vals) > 0 && vals[0] != "" {
				ctx = correlationid.WithContext(ctx, vals[0])
			}
		}
		return handler(ctx, req)
	}
}
