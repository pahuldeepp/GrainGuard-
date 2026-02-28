package grpc

import (
	"context"

	"github.com/pahuldeepp/grainguard/apps/telemetry-service/internal/application"
	devicepb "github.com/pahuldeepp/grainguard/libs/proto"
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

	device, err := s.service.Execute(
		ctx,
		req.TenantId,
		req.SerialNumber,
	)
	if err != nil {
		return nil, err
	}

	return &devicepb.CreateDeviceResponse{
		DeviceId: device.ID.String(),
	}, nil
}
