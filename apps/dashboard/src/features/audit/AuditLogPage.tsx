import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../../lib/apiFetch";
import { getAccessTokenSilently } from "../../lib/auth0";
import toast from "react-hot-toast";

const GW = import.meta.env.VITE_GATEWAY_URL ?? "";

interface AuditEvent {
  id: string;
  event_type: string;
  actor_id: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  created_at: string;
}

interface AuditResponse {
  events: AuditEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

const EVENT_TYPES = [
  "",
  "device.created",
  "device.creation_failed",
  "user.invited",
  "user.removed",
  "sso.configured",
  "sso.disabled",
  "alert_rule.created",
  "alert_rule.updated",
  "alert_rule.deleted",
  "billing.checkout_started",
  "billing.subscription_updated",
  "billing.subscription_canceled",
];

export function AuditLogPage() {
  const [events, setEvents]       = useState<AuditEvent[]>([]);
  const [loading, setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor]       = useState<string | null>(null);
  const [hasMore, setHasMore]     = useState(false);
  const [filterType, setFilterType] = useState("");
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async (reset = true) => {
    const isReset = reset;
    if (isReset) setLoading(true);
    else setLoadingMore(true);

    try {
      const params = new URLSearchParams({ limit: "50" });
      if (!isReset && cursor) params.set("before", cursor);
      if (filterType) params.set("event_type", filterType);

      const data: AuditResponse = await apiFetch(`/audit-logs?${params}`);

      setEvents((prev) => isReset ? data.events : [...prev, ...data.events]);
      setHasMore(data.hasMore);
      setCursor(data.nextCursor);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load audit log");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [cursor, filterType]);

  useEffect(() => { load(true); }, [filterType]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleExport() {
    setExporting(true);
    try {
      const token = await getAccessTokenSilently();
      const params = new URLSearchParams();
      if (filterType) params.set("event_type", filterType);

      const res = await fetch(`${GW}/audit-logs/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  function badgeColor(eventType: string): string {
    if (eventType.includes("created") || eventType.includes("configured"))
      return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300";
    if (eventType.includes("failed") || eventType.includes("canceled"))
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300";
    if (eventType.includes("updated") || eventType.includes("disabled"))
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300";
    if (eventType.includes("deleted") || eventType.includes("removed"))
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300";
    return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Audit Log</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            All account activity — for compliance and security review.
          </p>
        </div>
        <div className="flex gap-3">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">All events</option>
            {EVENT_TYPES.filter(Boolean).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
          >
            {exporting ? "Exporting…" : "↓ Export CSV"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">Loading…</div>
      ) : events.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-12 text-center">
          <p className="text-gray-500 dark:text-gray-400">No audit events found.</p>
        </div>
      ) : (
        <>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  {["Event", "Actor", "Resource", "IP Address", "When"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {events.map((ev) => (
                  <tr key={ev.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badgeColor(ev.event_type)}`}>
                        {ev.event_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 font-mono text-xs max-w-[180px] truncate">
                      {ev.actor_id}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">
                      {ev.resource_type}{ev.resource_id ? ` / ${ev.resource_id.slice(0, 8)}…` : ""}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">{ev.ip_address ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">
                      {new Date(ev.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div className="text-center mt-4">
              <button
                onClick={() => load(false)}
                disabled={loadingMore}
                className="px-6 py-2 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
              >
                {loadingMore ? "Loading…" : "Load More"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
