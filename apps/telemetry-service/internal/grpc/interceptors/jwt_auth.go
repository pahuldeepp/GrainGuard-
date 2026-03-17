package interceptors

import (
	"context"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc"
	"github.com/golang-jwt/jwt/v4"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

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

type JWTVerifier struct {
	JWKS     *keyfunc.JWKS
	Issuer   string
	Audience string
}

func NewJWTVerifier(jwksURL, issuer, audience string) (*JWTVerifier, error) {
	jwks, err := keyfunc.Get(jwksURL, keyfunc.Options{
		RefreshInterval: time.Hour,
		RefreshErrorHandler: func(err error) {
			// keep running using last-known keys
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

		claims := jwt.MapClaims{}

		parser := jwt.Parser{
			ValidMethods: []string{"RS256"},
		}

		tok, err := parser.ParseWithClaims(tokenStr, claims, v.JWKS.Keyfunc)
		if err != nil || tok == nil || !tok.Valid {
			return nil, status.Error(codes.Unauthenticated, "invalid token")
		}

		// ✅ Issuer check
		iss, _ := claims["iss"].(string)
		if v.Issuer != "" && iss != v.Issuer {
			return nil, status.Error(codes.Unauthenticated, "invalid issuer")
		}

		// ✅ Audience check
		if v.Audience != "" && !audMatches(claims["aud"], v.Audience) {
			return nil, status.Error(codes.Unauthenticated, "invalid audience")
		}

		// Extract sub
		sub, _ := claims["sub"].(string)

		// tenant_id — check standard claim first, then Auth0 namespaced
		tenantID, _ := claims["tenant_id"].(string)
		if tenantID == "" {
			if ns, ok := claims["https://grainguard/tenant_id"].(string); ok {
				tenantID = ns
			}
		}
		if tenantID == "" {
			return nil, status.Error(codes.PermissionDenied, "tenant_missing")
		}

		// scopes
		var scopes []string
		if scopeStr, ok := claims["scope"].(string); ok && scopeStr != "" {
			scopes = strings.Fields(scopeStr)
		}

		// roles — check standard claim first, then Auth0 namespaced
		var roles []string
		if rs, ok := claims["roles"].([]any); ok {
			for _, r := range rs {
				if s, ok := r.(string); ok {
					roles = append(roles, s)
				}
			}
		}
		// Auth0 namespaced roles fallback
		if len(roles) == 0 {
			if rs, ok := claims["https://ledgerflow.api/roles"].([]any); ok {
				for _, r := range rs {
					if s, ok := r.(string); ok {
						roles = append(roles, s)
					}
				}
			}
		}

		// strict tenant header check (optional)
		if mdTenant := first(md.Get("x-tenant-id")); mdTenant != "" && mdTenant != tenantID {
			return nil, status.Error(codes.PermissionDenied, "tenant_mismatch")
		}

		ctx = context.WithValue(ctx, authInfoKey, &AuthInfo{
			Sub:      sub,
			TenantID: tenantID,
			Roles:    roles,
			Scopes:   scopes,
		})

		return handler(ctx, req)
	}
}

func audMatches(aud any, expected string) bool {
	switch v := aud.(type) {
	case string:
		return v == expected
	case []any:
		for _, x := range v {
			if s, ok := x.(string); ok && s == expected {
				return true
			}
		}
		return false
	default:
		return false
	}
}

func first(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}