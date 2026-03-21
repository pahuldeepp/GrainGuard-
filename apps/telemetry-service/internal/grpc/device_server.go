package grpc

import (
	"context"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/application"
	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/grpc/interceptors"
	devicepb "github.com/pahuldeepp/grainguard/libs/proto"

	"google.golang.org/grpc/codes"
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
		return nil, status.Error(codes.Unauthenticated, "missing auth context")
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
