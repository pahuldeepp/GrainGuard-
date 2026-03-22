import { useEffect, useState } from "react";
import { getAccessTokenSilently } from "../../lib/auth0";
import toast from "react-hot-toast";

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  device_type: string | null;
  enabled: boolean;
  created_at: string;
}

const METRICS   = ["temperature", "humidity", "co2", "pressure", "battery"];
const OPERATORS = [">", "<", ">=", "<=", "=="];
const GW = import.meta.env.VITE_GATEWAY_URL ?? "";

async function apiFetch(path: string, options: RequestInit = {}) {
  const token = await getAccessTokenSilently();
  const res = await fetch(`${GW}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

const EMPTY_FORM = { name: "", metric: "temperature", operator: ">", threshold: "", device_type: "" };

export function AlertRulesPage() {
  const [rules, setRules]     = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]       = useState(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch("/alert-rules");
      setRules(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load rules");
    } finally {
      setLoading(false);
    }
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch("/alert-rules", {
        method: "POST",
        body: JSON.stringify({
          name:        form.name,
          metric:      form.metric,
          operator:    form.operator,
          threshold:   parseFloat(form.threshold),
          device_type: form.device_type || null,
        }),
      });
      toast.success("Alert rule created");
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create rule");
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(rule: AlertRule) {
    try {
      await apiFetch(`/alert-rules/${rule.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: !r.enabled } : r));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update rule");
    }
  }

  async function deleteRule(id: string) {
    if (!confirm("Delete this alert rule?")) return;
    try {
      await apiFetch(`/alert-rules/${id}`, { method: "DELETE" });
      toast.success("Rule deleted");
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete rule");
    }
  }

  const inputCls = "px-3 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500";

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Alert Rules</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            Define when alerts fire based on device telemetry values.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700"
        >
          + New Rule
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-6 mb-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-4">New Alert Rule</h2>
          <form onSubmit={createRule} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Rule Name</label>
              <input className={`${inputCls} w-full`} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. High temperature alert" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Metric</label>
              <select className={`${inputCls} w-full`} value={form.metric} onChange={(e) => setForm((f) => ({ ...f, metric: e.target.value }))}>
                {METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Operator</label>
              <select className={`${inputCls} w-full`} value={form.operator} onChange={(e) => setForm((f) => ({ ...f, operator: e.target.value }))}>
                {OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Threshold</label>
              <input className={`${inputCls} w-full`} type="number" step="any" value={form.threshold} onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))} placeholder="e.g. 35" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Device Type <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className={`${inputCls} w-full`} value={form.device_type} onChange={(e) => setForm((f) => ({ ...f, device_type: e.target.value }))} placeholder="Leave blank for all types" />
            </div>
            <div className="sm:col-span-2 flex gap-3 justify-end">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2">
                {saving && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {saving ? "Saving…" : "Create Rule"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rules list */}
      {loading ? (
        <div className="text-gray-500 dark:text-gray-400 text-sm">Loading…</div>
      ) : rules.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-12 text-center">
          <p className="text-gray-500 dark:text-gray-400">No alert rules yet. Create one above.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                {["Name", "Condition", "Device Type", "Enabled", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rules.map((rule) => (
                <tr key={rule.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{rule.name}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 font-mono">
                    {rule.metric} {rule.operator} {rule.threshold}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{rule.device_type ?? "All"}</td>
                  <td className="px-4 py-3">
                    {/* Toggle switch */}
                    <button
                      onClick={() => toggleRule(rule)}
                      className={`relative w-10 h-5 rounded-full transition-colors ${rule.enabled ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`}
                      aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${rule.enabled ? "translate-x-5" : ""}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => deleteRule(rule.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
