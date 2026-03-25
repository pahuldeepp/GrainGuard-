package grpc

import (
	"context"
	"os"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/application"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc/interceptors"
	devicepb "github.com/pahuldeepp/grainguard/libs/proto"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type DeviceServer struct {
	devicepb.UnimplementedDeviceServiceServer
	service *application.CreateDeviceService
}

func NewDeviceServer(s *application.CreateDeviceService) *DeviceServer {
	return &DeviceServer{service: s}
}

func (s *DeviceServer) CreateDevice(
	ctx context.Context,
	req *devicepb.CreateDeviceRequest,
) (*devicepb.CreateDeviceResponse, error) {

	// 🔒 Extract verified JWT claims from interceptor
	auth, ok := interceptors.GetAuthInfo(ctx)
	if !ok {
		// When AUTH_ENABLED=false the JWT interceptor is not registered.
		// Fall back to the x-tenant-id gRPC metadata header (set by gateway).
		if os.Getenv("AUTH_ENABLED") == "false" {
			tenantID := req.TenantId
			if md, hasMD := metadata.FromIncomingContext(ctx); hasMD {
				if vals := md.Get("x-tenant-id"); len(vals) > 0 {
					tenantID = vals[0]
				}
			}
			auth = &interceptors.AuthInfo{
				Sub:      "dev-user",
				TenantID: tenantID,
				Roles:    []string{"admin", "member"},
			}
		} else {
			return nil, status.Error(codes.Unauthenticated, "missing auth context")
		}
	}

	// 🔒 Enforce tenant isolation
	if req.TenantId != auth.TenantID {
		return nil, status.Error(codes.PermissionDenied, "tenant mismatch")
	}

	device, err := s.service.Execute(
		ctx,
		auth.TenantID, // 🔥 trust JWT, not raw request
		req.SerialNumber,
	)
	if err != nil {
		return nil, err
	}

	return &devicepb.CreateDeviceResponse{
		DeviceId: device.ID.String(),
	}, nil
}
