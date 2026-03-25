import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/apiFetch";
import toast from "react-hot-toast";

interface ApiKey {
  id: string;
  name: string;
  key?: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

const GW = import.meta.env.VITE_GATEWAY_URL ?? "";

export function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch("/api-keys");
      setKeys(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const data = await apiFetch("/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name,
          expiresInDays: expiresInDays ? parseInt(expiresInDays) : undefined,
        }),
      });
      setNewKey(data.key);
      toast.success("API key created");
      setName("");
      setExpiresInDays("");
      setShowForm(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create key");
    } finally {
      setSaving(false);
    }
  }

  async function revokeKey(id: string) {
    if (!confirm("Revoke this API key? Devices using it will stop working."))
      return;
    try {
      await apiFetch(`/api-keys/${id}`, { method: "DELETE" });
      toast.success("Key revoked");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke key");
    }
  }

  const inputCls =
    "px-3 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500";

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            API Keys
          </h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            Manage API keys for device telemetry ingestion.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700"
        >
          + New Key
        </button>
      </div>

      {newKey && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded-xl p-4 mb-6">
          <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-200 mb-2">
            Copy your API key now — it won't be shown again:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-white dark:bg-gray-800 px-3 py-2 rounded text-xs font-mono text-gray-900 dark:text-white border border-gray-200 dark:border-gray-700 break-all">
              {newKey}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(newKey);
                toast.success("Copied to clipboard");
              }}
              className="px-3 py-2 text-xs bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
            >
              Copy
            </button>
          </div>
          <button
            onClick={() => setNewKey(null)}
            className="mt-2 text-xs text-yellow-700 dark:text-yellow-300 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {showForm && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-6 mb-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-4">
            Create API Key
          </h2>
          <form onSubmit={createKey} className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Name
              </label>
              <input
                className={`${inputCls} w-full`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Silo A sensors"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Expires in (days)
              </label>
              <input
                className={`${inputCls} w-24`}
                type="number"
                min="1"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="Never"
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
            >
              {saving ? "Creating..." : "Create Key"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 dark:text-gray-400 text-sm">Loading...</div>
      ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-12 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            No API keys yet. Create one to start ingesting telemetry from devices.
          </p>
        </div>
      ) : (
        <>
          {activeKeys.length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow overflow-hidden mb-6">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    {["Name", "Created", "Expires", "Last Used", ""].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {activeKeys.map((k) => (
                    <tr key={k.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                        {k.name}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {new Date(k.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {k.expires_at
                          ? new Date(k.expires_at).toLocaleDateString()
                          : "Never"}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {k.last_used_at
                          ? new Date(k.last_used_at).toLocaleDateString()
                          : "Never"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => revokeKey(k.id)}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {revokedKeys.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2">
                Revoked Keys
              </h2>
              <div className="bg-white dark:bg-gray-900 rounded-xl shadow overflow-hidden opacity-60">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {revokedKeys.map((k) => (
                      <tr key={k.id}>
                        <td className="px-4 py-2 text-gray-500 dark:text-gray-400 line-through">
                          {k.name}
                        </td>
                        <td className="px-4 py-2 text-gray-400 dark:text-gray-500 text-xs">
                          Revoked {new Date(k.revoked_at!).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-6 bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Usage
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          Send telemetry from your devices using the API key:
        </p>
        <code className="block bg-white dark:bg-gray-800 px-3 py-2 rounded text-xs font-mono text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-700">
          {`curl -X POST ${GW || "https://api.grainguard.com"}/ingest \\`}
          <br />
          {`  -H "X-Api-Key: gg_your_key_here" \\`}
          <br />
          {`  -H "Content-Type: application/json" \\`}
          <br />
          {`  -d '{"serialNumber": "SENSOR-001"}'`}
        </code>
      </div>
    </div>
  );
}
