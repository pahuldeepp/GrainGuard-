package interceptors

import (
	"context"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc"
	"github.com/golang-jwt/jwt/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

/* =========================
   Auth Context Types
========================= */

type AuthInfo struct {
	Sub      string
	TenantID string
	Roles    []string
	Scopes   []string
}

type ctxKey string

const authInfoKey ctxKey = "authInfo"

func GetAuthInfo(ctx context.Context) (*AuthInfo, bool) {
	v := ctx.Value(authInfoKey)
	if v == nil {
		return nil, false
	}
	a, ok := v.(*AuthInfo)
	return a, ok
}

/* =========================
   JWKS Verifier
========================= */

type JWTVerifier struct {
	JWKS     *keyfunc.JWKS
	Issuer   string
	Audience string
}

func NewJWTVerifier(jwksURL, issuer, audience string) (*JWTVerifier, error) {
	jwks, err := keyfunc.Get(jwksURL, keyfunc.Options{
		RefreshInterval: time.Hour,
		RefreshErrorHandler: func(err error) {
			// Keep running even if refresh fails (use last known keys)
		},
	})
	if err != nil {
		return nil, err
	}

	return &JWTVerifier{
		JWKS:     jwks,
		Issuer:   issuer,
		Audience: audience,
	}, nil
}

/* =========================
   gRPC Interceptor
========================= */

func (v *JWTVerifier) UnaryAuthInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "missing metadata")
		}

		authHeaders := md.Get("authorization")
		if len(authHeaders) == 0 {
			return nil, status.Error(codes.Unauthenticated, "missing authorization")
		}

		raw := authHeaders[0]
		if !strings.HasPrefix(raw, "Bearer ") {
			return nil, status.Error(codes.Unauthenticated, "invalid authorization header")
		}

		tokenStr := strings.TrimSpace(strings.TrimPrefix(raw, "Bearer "))
		if tokenStr == "" {
			return nil, status.Error(codes.Unauthenticated, "empty token")
		}

		parsed, err := jwt.Parse(tokenStr, v.JWKS.Keyfunc,
			jwt.WithIssuer(v.Issuer),
			jwt.WithAudience(v.Audience),
			jwt.WithValidMethods([]string{"RS256"}), // 🔥 enforce algorithm
		)
		if err != nil || !parsed.Valid {
			return nil, status.Error(codes.Unauthenticated, "invalid token")
		}

		claims, ok := parsed.Claims.(jwt.MapClaims)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "invalid claims")
		}

		// Extract sub
		sub, _ := claims["sub"].(string)

		// Extract tenant_id (support custom namespace too)
		tenantID, _ := claims["tenant_id"].(string)
		if tenantID == "" {
			if ns, ok := claims["https://grainguard/tenant_id"].(string); ok {
				tenantID = ns
			}
		}
		if tenantID == "" {
			return nil, status.Error(codes.PermissionDenied, "tenant_missing")
		}

		// Extract scopes (OIDC standard: "scope": "a b c")
		var scopes []string
		if scopeStr, ok := claims["scope"].(string); ok && scopeStr != "" {
			scopes = strings.Fields(scopeStr)
		}

		// Extract roles (optional: "roles": ["admin"])
		var roles []string
		if rs, ok := claims["roles"].([]any); ok {
			for _, r := range rs {
				if s, ok := r.(string); ok {
					roles = append(roles, s)
				}
			}
		}

		// OPTIONAL: Tenant consistency check (metadata x-tenant-id)
		// We'll make it strict in Step 2, but we can already validate here:
		if mdTenant := first(md.Get("x-tenant-id")); mdTenant != "" && mdTenant != tenantID {
			return nil, status.Error(codes.PermissionDenied, "tenant_mismatch")
		}

		auth := &AuthInfo{
			Sub:      sub,
			TenantID: tenantID,
			Roles:    roles,
			Scopes:   scopes,
		}

		ctx = context.WithValue(ctx, authInfoKey, auth)
		return handler(ctx, req)
	}
}

func first(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}