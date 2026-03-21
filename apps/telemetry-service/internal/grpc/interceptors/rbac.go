// review-sweep
package interceptors

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

/*
RBAC policy:
- Enforce per-method scopes OR admin role
- Enforce tenant isolation
*/

var methodScopes = map[string][]string{
	"/device.DeviceService/CreateDevice": {"device:create"},
	// "/telemetry.TelemetryService/RecordTelemetry": {"telemetry:write"},
}

func RBACUnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {

		// ✅ 1. Get verified JWT info from context
		auth, ok := GetAuthInfo(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "missing auth context")
		}

		// ✅ 2. Tenant enforcement
		md, _ := metadata.FromIncomingContext(ctx)
		if md != nil {
			mdTenant := first(md.Get("x-tenant-id"))
			if mdTenant != "" && mdTenant != auth.TenantID {
				return nil, status.Error(codes.PermissionDenied, "tenant_mismatch")
			}
		}

		// ✅ 3. Scope enforcement — admin role bypasses scope requirement
		requiredScopes := methodScopes[info.FullMethod]
		if len(requiredScopes) > 0 {
			if !isAdmin(auth.Roles) && !hasAnyScope(auth.Scopes, requiredScopes) {
				return nil, status.Error(codes.PermissionDenied, "missing_required_scope")
			}
		}

		return handler(ctx, req)
	}
}

func isAdmin(roles []string) bool {
	for _, r := range roles {
		if r == "admin" {
			return true
		}
	}
	return false
}

func hasAnyScope(userScopes []string, required []string) bool {
	scopeSet := make(map[string]struct{}, len(userScopes))
	for _, s := range userScopes {
		scopeSet[s] = struct{}{}
	}
	for _, r := range required {
		if _, ok := scopeSet[r]; ok {
			return true
		}
	}
	return false
}