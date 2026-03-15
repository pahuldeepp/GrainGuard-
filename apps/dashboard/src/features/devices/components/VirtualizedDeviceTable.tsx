
import { memo, useCallback } from "react";
import { FixedSizeList as List } from "react-window";
import { useNavigate } from "react-router-dom";
import type { Device } from "../types";
import { TelemetryBadge } from "../../telemetry/components/TelemetryBadge";
interface Props {
  devices: Device[];
}

const ROW_HEIGHT = 52;
const MAX_VISIBLE_ROWS = 12;

interface RowProps {
  index: number;
  style: React.CSSProperties;
  data: {
    devices: Device[];
    onRowClick: (deviceId: string) => void;
  };
}

const DeviceRow = memo(function DeviceRow({ index, style, data }: RowProps) {
  const device = data.devices[index];

  return (
    <div
      style={style}
      role="row"
      tabIndex={0}
      aria-label={`Device ${device.serialNumber}, click to view details`}
      onClick={() => data.onRowClick(device.deviceId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          data.onRowClick(device.deviceId);
        }
      }}
      className={`
        flex items-center px-4 border-b border-gray-100 dark:border-gray-800
        hover:bg-blue-50 dark:hover:bg-gray-800 cursor-pointer transition-colors
        focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-500
        ${index % 2 === 0 ? "bg-white dark:bg-gray-900" : "bg-gray-50/50 dark:bg-gray-900/50"}
      `}
    >
      {/* Serial Number */}
      <div className="flex-1 min-w-0">
        <span className="font-medium text-gray-900 dark:text-white text-sm truncate block">
          {device.serialNumber}
        </span>
      </div>

      {/* Device ID */}
      <div className="w-28 hidden sm:block">
        <span className="text-gray-500 dark:text-gray-400 font-mono text-xs">
          {device.deviceId.slice(0, 8)}...
        </span>
      </div>

      {/* Temperature */}
      <div className="w-28">
        <TelemetryBadge value={device.temperature} unit="�C" high={40} />
      </div>

      {/* Humidity */}
      <div className="w-24 hidden md:block">
        <TelemetryBadge value={device.humidity} unit="%" high={90} />
      </div>

      {/* Last Reading */}
      <div className="w-36 hidden lg:block">
        <span className="text-gray-500 dark:text-gray-400 text-xs">
          {device.recordedAt
            ? new Date(device.recordedAt).toLocaleString()
            : "�"}
        </span>
      </div>
    </div>
  );
});

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

  const listHeight = Math.min(devices.length, MAX_VISIBLE_ROWS) * ROW_HEIGHT;

  const itemData = {
    devices,
    onRowClick: handleRowClick,
  };

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

      {/* Virtualized rows */}
      <List
        height={listHeight}
        itemCount={devices.length}
        itemSize={ROW_HEIGHT}
        width="100%"
        itemData={itemData}
        overscanCount={5}
      >
        {DeviceRow}
      </List>

      {/* Footer � row count */}
      <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {devices.length} device{devices.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
});
