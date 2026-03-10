import { useParams, useNavigate } from "react-router-dom";
import { useDevice } from "../hooks/useDevices";
import { TelemetryBadge } from "../../telemetry/components/TelemetryBadge";
import { Skeleton } from "../../../shared/components/Skeleton";
import { TelemetryChart } from "../../telemetry/components/TelemetryChart";
import { useDeviceTelemetryHistory } from "../hooks/useDevices";
export function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { device, loading, error } = useDevice(id!);
const { telemetryHistory: history, loading: historyLoading } = useDeviceTelemetryHistory(id!);
  if (loading) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="p-8 text-center">
        <div className="text-red-500 text-lg font-medium">Device not found</div>
        <button
          onClick={() => navigate("/")}
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Back to Devices
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => navigate("/")}
        className="text-blue-600 hover:text-blue-800 text-sm mb-6 flex items-center gap-1"
      >
        â† Back to Devices
      </button>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{device.serialNumber}</h1>
        <p className="text-gray-500 text-sm mt-1 font-mono">{device.deviceId}</p>
      </div>

      {/* Device info */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-4">Device Info</h2>
        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-gray-600">Serial Number</span>
            <span className="font-medium">{device.serialNumber}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Tenant ID</span>
            <span className="font-mono text-sm text-gray-500">{device.tenantId}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Device ID</span>
            <span className="font-mono text-sm text-gray-500">{device.deviceId}</span>
          </div>
        </div>
      </div>

      {/* Latest telemetry */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-4">Latest Telemetry</h2>
        {device.temperature === null ? (
          <div className="text-gray-400 text-center py-4">No telemetry data yet</div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Temperature</span>
              <TelemetryBadge value={device.temperature} unit="Â°C" high={40} />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Humidity</span>
              <TelemetryBadge value={device.humidity} unit="%" high={90} />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Last Reading</span>
              <span className="text-sm text-gray-500">
                {device.recordedAt
                  ? new Date(device.recordedAt).toLocaleString()
                  : "â€”"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Telemetry Chart */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-4">
          Telemetry History
        </h2>
        <TelemetryChart history={history} loading={historyLoading} />
      </div>
    </div>
  );
}
