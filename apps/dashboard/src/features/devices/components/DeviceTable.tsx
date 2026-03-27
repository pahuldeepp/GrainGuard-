import { memo } from "react";
import type { Device } from "../types";
import { EmptyState } from "../../../shared/components/EmptyState";
import { DeviceRowSkeleton } from "../../../shared/components/Skeleton";
import { TelemetryBadge } from "../../telemetry/components/TelemetryBadge";
import { useNavigate } from "react-router-dom";

interface Props {
  devices: Device[];
  loading: boolean;
}

export const DeviceTable = memo(function DeviceTable({ devices, loading }: Props) {
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Serial Number</th>
              <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Device ID</th>
              <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Temperature</th>
              <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Humidity</th>
              <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Last Reading</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 8 }).map((_, i) => (
              <DeviceRowSkeleton key={i} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow">
        <EmptyState
          icon="inbox"
          title="No devices found"
          description="No devices have been registered yet. Devices will appear here once they connect and send telemetry."
        />
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow overflow-hidden">
      <table
        className="w-full text-left text-sm"
        role="grid"
        aria-label="Devices list"
      >
        <caption className="sr-only">
          List of registered GrainGuard devices with telemetry status
        </caption>
        <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Serial Number</th>
            <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Device ID</th>
            <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Temperature</th>
            <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Humidity</th>
            <th scope="col" className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-300">Last Reading</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr
              key={device.deviceId}
              onClick={() => navigate(`/devices/${device.deviceId}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/devices/${device.deviceId}`);
                }
              }}
              tabIndex={0}
              role="row"
              aria-label={`Device ${device.serialNumber}, click to view details`}
              className="border-b border-gray-100 dark:border-gray-800 hover:bg-blue-50 dark:hover:bg-gray-800 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-500"
            >
              <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                {device.serialNumber}
              </td>
              <td className="px-4 py-3 text-gray-500 dark:text-gray-400 font-mono text-xs">
                {device.deviceId.slice(0, 8)}...
              </td>
              <td className="px-4 py-3">
                <TelemetryBadge value={device.temperature} unit="C" high={40} />
              </td>
              <td className="px-4 py-3">
                <TelemetryBadge value={device.humidity} unit="%" high={90} />
              </td>
              <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                {device.recordedAt ? new Date(device.recordedAt).toLocaleString() : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
