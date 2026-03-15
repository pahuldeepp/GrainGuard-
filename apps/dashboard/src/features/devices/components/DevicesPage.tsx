import { useState, useMemo, useCallback } from "react";
import { useDevices } from "../hooks/useDevices";
import { useDebounce } from "../../../hooks/useDebounce";
import { DeviceTable } from "./DeviceTable";
import { EmptyState } from "../../../shared/components/EmptyState";
import toast from "react-hot-toast";

type StatusFilter = "all" | "with-telemetry" | "no-data";
const PAGE_SIZE = 20;

export function DevicesPage() {
  const [limit, setLimit] = useState(200);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);

  const { devices, loading, error, refetch } = useDevices(limit);

  // Debounce search — filter only fires 300ms after user stops typing
  const debouncedSearch = useDebounce(search, 300);

  // Stable function references — won't break React.memo on DeviceTable
  const handleRefetch = useCallback(async () => {
    try {
      await refetch();
      toast.success("Devices refreshed");
    } catch {
      toast.error("Failed to refresh devices");
    }
  }, [refetch]);

  const handleSearch = useCallback((val: string) => {
    setSearch(val);
    setPage(1);
  }, []);

  const handleStatus = useCallback((val: StatusFilter) => {
    setStatusFilter(val);
    setPage(1);
  }, []);

  const handleClear = useCallback(() => {
    setSearch("");
    setStatusFilter("all");
    setPage(1);
  }, []);

  // Stats — memoized separately so they don't recompute on page change
  const stats = useMemo(() => ({
    total: devices.length,
    withTelemetry: devices.filter((d) => d.temperature !== null).length,
    noData: devices.filter((d) => d.temperature === null).length,
  }), [devices]);

  // Filter uses debouncedSearch not raw search
  const filteredDevices = useMemo(() => {
    let result = devices;
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter(
        (d) =>
          d.serialNumber.toLowerCase().includes(q) ||
          d.deviceId.toLowerCase().includes(q)
      );
    }
    if (statusFilter === "with-telemetry") {
      result = result.filter((d) => d.temperature !== null);
    } else if (statusFilter === "no-data") {
      result = result.filter((d) => d.temperature === null);
    }
    return result;
  }, [devices, debouncedSearch, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredDevices.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pagedDevices = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredDevices.slice(start, start + PAGE_SIZE);
  }, [filteredDevices, safePage]);

  const isFiltering = search.trim() !== "" || statusFilter !== "all";

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
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            {loading
              ? "Loading..."
              : isFiltering
              ? `${filteredDevices.length} of ${stats.total} devices`
              : `${stats.total} devices`}
          </p>
        </div>
        <div className="flex gap-3">
          <select
            value={limit}
            onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
            className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded px-3 py-2 text-sm"
          >
            <option value={50}>Fetch 50</option>
            <option value={100}>Fetch 100</option>
            <option value={200}>Fetch 200</option>
          </select>
          <button
            onClick={handleRefetch}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            Refresh
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
        <DeviceTable devices={pagedDevices} loading={loading} />
      </div>

      {/* Pagination */}
      {!loading && filteredDevices.length > PAGE_SIZE && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mt-4 px-1">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Showing {((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filteredDevices.length)} of {filteredDevices.length}
          </p>
          <div className="flex items-center gap-1 flex-wrap">
            <button onClick={() => setPage(1)} disabled={safePage === 1}
              className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed">«</button>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1}
              className="px-3 py-1 text-sm rounded border border-gray-300 dark:border-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed">Prev</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
              .reduce<(number | "...")[]>((acc, p, i, arr) => {
                if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push("...");
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) =>
                p === "..." ? (
                  <span key={`ellipsis-${i}`} className="px-2 text-gray-400">…</span>
                ) : (
                  <button key={p} onClick={() => setPage(p as number)}
                    className={`px-3 py-1 text-sm rounded border transition-colors ${
                      safePage === p
                        ? "bg-green-600 text-white border-green-600"
                        : "border-gray-300 dark:border-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                    }`}>{p}</button>
                )
              )}
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
              className="px-3 py-1 text-sm rounded border border-gray-300 dark:border-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed">Next</button>
            <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages}
              className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed">»</button>
          </div>
        </div>
      )}
    </div>
  );
}