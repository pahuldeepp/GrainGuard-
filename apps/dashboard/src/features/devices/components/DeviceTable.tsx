import { useNavigate } from "react-router-dom";
import type { Device as DeviceType } from "../types";
import { TelemetryBadge } from "../../telemetry/components/TelemetryBadge";
import { DeviceRowSkeleton } from "../../../shared/components/Skeleton";
interface Props {
  devices: DeviceType[];
  loading: boolean;
}

export function DeviceTable({ devices, loading }: Props) {
  const navigate = useNavigate();

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="px-4 py-3 font-semibold text-gray-600">Serial Number</th>
            <th className="px-4 py-3 font-semibold text-gray-600">Device ID</th>
            <th className="px-4 py-3 font-semibold text-gray-600">Temperature</th>
            <th className="px-4 py-3 font-semibold text-gray-600">Humidity</th>
            <th className="px-4 py-3 font-semibold text-gray-600">Last Reading</th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: 8 }).map((_, i) => (
            <DeviceRowSkeleton key={i} />
          ))}
          {!loading && devices.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                No devices found
              </td>
            </tr>
          )}
          {!loading && devices.map((device) => (
            <tr
              key={device.deviceId}
              onClick={() => navigate(`/devices/${device.deviceId}`)}
              className="border-b border-gray-100 hover:bg-blue-50 cursor-pointer transition-colors"
            >
              <td className="px-4 py-3 font-medium text-gray-900">
                {device.serialNumber}
              </td>
              <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                {device.deviceId.slice(0, 8)}...
              </td>
              <td className="px-4 py-3">
                <TelemetryBadge value={device.temperature} unit="°C" high={40} />
              </td>
              <td className="px-4 py-3">
                <TelemetryBadge value={device.humidity} unit="%" high={90} />
              </td>
              <td className="px-4 py-3 text-gray-500 text-xs">
                {device.recordedAt
                  ? new Date(device.recordedAt).toLocaleString()
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}