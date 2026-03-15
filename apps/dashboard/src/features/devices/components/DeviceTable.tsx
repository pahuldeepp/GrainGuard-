import { memo } from "react";
import { useNavigate } from "react-router-dom";
import type { Device as DeviceType } from "../types";
import { TelemetryBadge } from "../../telemetry/components/TelemetryBadge";
import { DeviceRowSkeleton } from "../../../shared/components/Skeleton";
import { EmptyState } from "../../../shared/components/EmptyState";

interface Props {
  devices: DeviceType[];
  loading: boolean;
}

export const DeviceTable = memo(function DeviceTable({ devices, loading }: Props) {
  const navigate = useNavigate();

  if (!loading && devices.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow">
        <EmptyState
          icon="🌾"
          title="No devices found"
          description="No devices have been registered yet. Devices will appear here once they connect and send telemetry."
        />
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <tr>
            <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Serial Number</th>
            <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Device ID</th>
            <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Temperature</th>
            <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Humidity</th>
            <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Last Reading</th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: 8 }).map((_, i) => (
            <DeviceRowSkeleton key={i} />
          ))}
          {!loading && devices.map((device) => (
            <tr
              key={device.deviceId}
              onClick={() => navigate(`/devices/${device.deviceId}`)}
              className="border-b border-gray-100 dark:border-gray-800 hover:bg-blue-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
            >
              <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                {device.serialNumber}
              </td>
              <td className="px-4 py-3 text-gray-500 dark:text-gray-400 font-mono text-xs">
                {device.deviceId.slice(0, 8)}...
              </td>
              <td className="px-4 py-3">
                <TelemetryBadge value={device.temperature} unit="°C" high={40} />
              </td>
              <td className="px-4 py-3">
                <TelemetryBadge value={device.humidity} unit="%" high={90} />
              </td>
              <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                {device.recordedAt ? new Date(device.recordedAt).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});