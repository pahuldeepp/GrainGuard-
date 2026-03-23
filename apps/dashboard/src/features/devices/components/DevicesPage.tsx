import { useState, useMemo, useCallback } from "react";
import { Navigate } from "react-router-dom";
import { useDevices, useSearchDevices } from "../hooks/useDevices";
import { useDebounce } from "../../../hooks/useDebounce";
import { DeviceTable } from "./DeviceTable";
import { EmptyState } from "../../../shared/components/EmptyState";
import { useTenantContext } from "../../tenancy/TenantContext";
import { RegisterDeviceModal } from "./RegisterDeviceModal";
import toast from "react-hot-toast";
import { exportDevicesToCsv, buildCsvFilename } from "../../../utils/exportCsv";

type StatusFilter = "all" | "with-telemetry" | "no-data";

export function DevicesPage() {
  const [limit, setLimit] = useState(200);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showRegister, setShowRegister] = useState(false);

  const { activeTenantId } = useTenantContext();
  const debouncedSearch = useDebounce(search, 300);
  const { devices, loading, error, refetch } = useDevices(limit);
  const { results: searchResults } = useSearchDevices(debouncedSearch);

  const isSearching = debouncedSearch.trim().length >= 2;

  const handleRefetch = useCallback(async () => {
    try {
      await refetch();
      toast.success("Devices refreshed");
    } catch {
      toast.error("Failed to refresh devices");
    }
  }, [refetch]);

  const handleSearch = useCallback((val: string) => setSearch(val), []);
  const handleStatus = useCallback((val: StatusFilter) => setStatusFilter(val), []);
  const handleClear = useCallback(() => {
    setSearch("");
    setStatusFilter("all");
  }, []);

  const stats = useMemo(() => ({
    total: devices.length,
    withTelemetry: devices.filter((d) => d.temperature !== null).length,
    noData: devices.filter((d) => d.temperature === null).length,
  }), [devices]);

  const filteredDevices = useMemo(() => {
    let result = isSearching ? searchResults : devices;
    if (statusFilter === "with-telemetry") {
      result = result.filter((d) => d.temperature !== null);
    } else if (statusFilter === "no-data") {
      result = result.filter((d) => d.temperature === null);
    }
    return result;
  }, [devices, searchResults, isSearching, statusFilter]);

  const isFiltering = search.trim() !== "" || statusFilter !== "all";

  const handleExport = useCallback(() => {
    if (filteredDevices.length === 0) {
      toast.error("No devices to export");
      return;
    }
    exportDevicesToCsv(
      filteredDevices,
      buildCsvFilename(isFiltering, filteredDevices.length)
    );
    toast.success(`Exported ${filteredDevices.length} devices to CSV`);
  }, [filteredDevices, isFiltering]);

  if (!activeTenantId) {
    return <Navigate to="/onboarding" replace />;
  }

  if (error) {
    return (
      <div className="p-8">
        <EmptyState
          icon="⚠️"
          title="Failed to load devices"
          description={error.message}
          action={{ label: "Retry", onClick: handleRefetch }}
        />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Devices</h1>
          <p
            className="text-gray-500 dark:text-gray-400 text-sm mt-1"
            aria-live="polite"
            aria-atomic="true"
          >
            {loading
              ? "Loading..."
              : isFiltering
              ? `${filteredDevices.length} of ${stats.total} devices`
              : `${stats.total} devices`}
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded px-3 py-2 text-sm"
          >
            <option value={50}>Fetch 50</option>
            <option value={100}>Fetch 100</option>
            <option value={200}>Fetch 200</option>
          </select>
          <button
            onClick={handleExport}
            disabled={loading || filteredDevices.length === 0}
            className="px-4 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 rounded text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ↓ Export CSV
          </button>
          <button
            onClick={handleRefetch}
            className="px-4 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 rounded text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowRegister(true)}
            className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 transition-colors font-medium"
          >
            + Register Device
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Devices</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
            {loading ? "—" : stats.total}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">With Telemetry</div>
          <div className="text-2xl font-bold text-green-600 mt-1">
            {loading ? "—" : stats.withTelemetry}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">No Data</div>
          <div className="text-2xl font-bold text-gray-400 mt-1">
            {loading ? "—" : stats.noData}
          </div>
        </div>
      </div>

      {/* Search + filter */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
          <input
            type="text"
            aria-label="Search devices by serial number or device ID"
            placeholder="Search by serial number or device ID..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full pl-8 pr-4 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          {search && (
            <button
              onClick={() => handleSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none"
            >×</button>
          )}
        </div>
        <select
          aria-label="Filter by telemetry status"
          value={statusFilter}
          onChange={(e) => handleStatus(e.target.value as StatusFilter)}
          className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="all">All Status</option>
          <option value="with-telemetry">With Telemetry</option>
          <option value="no-data">No Data</option>
        </select>
        {isFiltering && (
          <button
            onClick={handleClear}
            className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg">
        <DeviceTable devices={filteredDevices} loading={loading} />
      </div>

      {/* Register modal */}
      <RegisterDeviceModal
        open={showRegister}
        onClose={() => setShowRegister(false)}
        onRegistered={handleRefetch}
      />
    </div>
  );
}
