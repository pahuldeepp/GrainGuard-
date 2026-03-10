import { useState } from "react";
import { useDevices } from "../hooks/useDevices";
import { DeviceTable } from "./DeviceTable";

export function DevicesPage() {
  const [limit, setLimit] = useState(50);
  const { devices, loading, error, refetch } = useDevices(limit);

  if (error) {
    return (
      <div className="p-8 text-center">
        <div className="text-red-500 text-lg font-medium">Failed to load devices</div>
        <div className="text-gray-500 text-sm mt-1">{error.message}</div>
        <button
          onClick={() => refetch()}
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Devices</h1>
          <p className="text-gray-500 text-sm mt-1">
            {loading ? "Loading..." : `${devices.length} devices`}
          </p>
        </div>
        <div className="flex gap-3">
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="border border-gray-300 rounded px-3 py-2 text-sm"
          >
            <option value={20}>Show 20</option>
            <option value={50}>Show 50</option>
            <option value={100}>Show 100</option>
            <option value={200}>Show 200</option>
          </select>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Devices</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">
            {loading ? "—" : devices.length}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">With Telemetry</div>
          <div className="text-2xl font-bold text-green-600 mt-1">
            {loading ? "—" : devices.filter(d => d.temperature !== null).length}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">No Data</div>
          <div className="text-2xl font-bold text-gray-400 mt-1">
            {loading ? "—" : devices.filter(d => d.temperature === null).length}
          </div>
        </div>
      </div>

      {/* Table */}
      <DeviceTable devices={devices} loading={loading} />
    </div>
  );
}