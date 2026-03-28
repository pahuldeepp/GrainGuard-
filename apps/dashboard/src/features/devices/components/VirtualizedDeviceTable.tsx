import { memo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { Device } from "../types";
import { TelemetryBadge } from "../../telemetry/components/TelemetryBadge";
interface Props {
  devices: Device[];
}

export const VirtualizedDeviceTable = memo(function VirtualizedDeviceTable({
  devices,
}: Props) {
  const navigate = useNavigate();

  const handleRowClick = useCallback(
    (deviceId: string) => {
      navigate(`/devices/${deviceId}`);
    },
    [navigate]
  );

  return (
    <div
      className="bg-white dark:bg-gray-900 rounded-lg shadow overflow-hidden"
      role="grid"
      aria-label="Devices list"
      aria-rowcount={devices.length}
    >
      {/* Table header */}
      <div className="flex items-center px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex-1 text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">
          Serial Number
        </div>
        <div className="w-28 hidden sm:block text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">
          Device ID
        </div>
        <div className="w-28 text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">
          Temperature
        </div>
        <div className="w-24 hidden md:block text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">
          Humidity
        </div>
        <div className="w-36 hidden lg:block text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">
          Last Reading
        </div>
      </div>

      <div role="rowgroup">
        {devices.map((device, index) => (
          <div
            key={device.deviceId}
            role="row"
            tabIndex={0}
            aria-label={`Device ${device.serialNumber}, click to view details`}
            onClick={() => handleRowClick(device.deviceId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleRowClick(device.deviceId);
              }
            }}
            className={[
              "flex items-center px-4 py-3 border-b border-gray-100 dark:border-gray-800",
              "hover:bg-blue-50 dark:hover:bg-gray-800 cursor-pointer transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-500",
              index % 2 === 0 ? "bg-white dark:bg-gray-900" : "bg-gray-50/50 dark:bg-gray-900/50",
            ].join(" ")}
          >
            <div className="flex-1 min-w-0">
              <span className="font-medium text-gray-900 dark:text-white text-sm truncate block">
                {device.serialNumber}
              </span>
            </div>
            <div className="w-28 hidden sm:block">
              <span className="text-gray-500 dark:text-gray-400 font-mono text-xs">
                {device.deviceId.slice(0, 8)}...
              </span>
            </div>
            <div className="w-28">
              <TelemetryBadge value={device.temperature} unit="C" high={40} />
            </div>
            <div className="w-24 hidden md:block">
              <TelemetryBadge value={device.humidity} unit="%" high={90} />
            </div>
            <div className="w-36 hidden lg:block">
              <span className="text-gray-500 dark:text-gray-400 text-xs">
                {device.recordedAt ? new Date(device.recordedAt).toLocaleString() : "-"}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {devices.length} device{devices.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
});
