import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../lib/apiFetch";
import { useAuth } from "../../hooks/useAuth";
import toast from "react-hot-toast";

interface WebhookEndpoint {
  id:          string;
  url:         string;
  description: string | null;
  enabled:     boolean;
  event_types: string[];
  created_at:  string;
  updated_at:  string;
  last_error:  string | null;
}

const ALL_EVENT_TYPES = [
  "device.created",
  "device.deleted",
  "telemetry.alert",
  "team.member_invited",
  "team.member_removed",
  "billing.subscription_created",
  "billing.subscription_cancelled",
  "api_key.created",
  "api_key.revoked",
];

export function WebhooksPage() {
  const { isAdmin }                   = useAuth();
  const [endpoints, setEndpoints]     = useState<WebhookEndpoint[]>([]);
  const [loading,   setLoading]       = useState(true);
  const [creating,  setCreating]      = useState(false);
  const [newSecret, setNewSecret]     = useState<string | null>(null);
  const [newEndpointId, setNewEndpointId] = useState<string | null>(null);
  const [showForm,  setShowForm]      = useState(false);
  const [testing,   setTesting]       = useState<string | null>(null);

  // New endpoint form state
  const [formUrl,   setFormUrl]       = useState("");
  const [formDesc,  setFormDesc]      = useState("");
  const [formTypes, setFormTypes]     = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch("/webhooks");
      setEndpoints(data);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const data = await apiFetch("/webhooks", {
        method: "POST",
        body:   JSON.stringify({ url: formUrl, description: formDesc, eventTypes: formTypes }),
      });
      setNewSecret(data.secret);
      setNewEndpointId(data.id);
      setFormUrl("");
      setFormDesc("");
      setFormTypes([]);
      setShowForm(false);
      await load();
      toast.success("Webhook endpoint created");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to create webhook");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    try {
      await apiFetch(`/webhooks/${id}`, {
        method: "PATCH",
        body:   JSON.stringify({ enabled }),
      });
      await load();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update webhook");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this webhook endpoint? All delivery history will also be removed.")) return;
    try {
      await apiFetch(`/webhooks/${id}`, { method: "DELETE" });
      setEndpoints((prev) => prev.filter((e) => e.id !== id));
      toast.success("Webhook deleted");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to delete webhook");
    }
  }

  async function handleTest(id: string) {
    setTesting(id);
    try {
      const data = await apiFetch(`/webhooks/${id}/test`, { method: "POST" });
      if (data.success) {
        toast.success(`Test delivery succeeded (HTTP ${data.statusCode}, ${data.durationMs}ms)`);
      } else {
        toast.error(`Test delivery failed (HTTP ${data.statusCode || "timeout"})`);
      }
    } catch (e: any) {
      toast.error(e.message ?? "Test failed");
    } finally {
      setTesting(null);
    }
  }

  function toggleEventType(t: string) {
    setFormTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Webhooks</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Receive real-time HTTP notifications when events happen in your workspace.
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {showForm ? "Cancel" : "+ Add Endpoint"}
          </button>
        )}
      </div>

      {/* One-time secret reveal banner */}
      {newSecret && (
        <div className="mb-6 rounded-xl bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700 p-5">
          <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-300 mb-2">
            ⚠ Copy your signing secret — it won't be shown again
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-yellow-100 dark:bg-yellow-900/60 rounded px-3 py-2 font-mono break-all text-yellow-900 dark:text-yellow-200">
              {newSecret}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(newSecret);
                toast.success("Secret copied!");
              }}
              className="shrink-0 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 text-white text-xs rounded-lg"
            >
              Copy
            </button>
          </div>
          <button
            onClick={() => { setNewSecret(null); setNewEndpointId(null); }}
            className="mt-3 text-xs text-yellow-700 dark:text-yellow-400 underline"
          >
            I've saved the secret
          </button>
        </div>
      )}

      {/* Create form */}
      {showForm && isAdmin && (
        <form
          onSubmit={handleCreate}
          className="mb-8 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6 space-y-4"
        >
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">New Endpoint</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              URL <span className="text-red-500">*</span>
            </label>
            <input
              type="url"
              required
              placeholder="https://your-server.com/webhooks/grainguard"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-400 mt-1">Must be HTTPS.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Description
            </label>
            <input
              type="text"
              placeholder="e.g. Production alert handler"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>

          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Event Types <span className="text-gray-400 font-normal">(empty = all events)</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {ALL_EVENT_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleEventType(t)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    formTypes.includes(t)
                      ? "bg-green-100 dark:bg-green-900/50 border-green-400 text-green-800 dark:text-green-300"
                      : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create Endpoint"}
          </button>
        </form>
      )}

      {/* Endpoints list */}
      {loading ? (
        <p className="text-gray-500 dark:text-gray-400 text-sm">Loading…</p>
      ) : endpoints.length === 0 ? (
        <div className="text-center py-16 text-gray-400 dark:text-gray-500">
          <div className="text-4xl mb-3">🔗</div>
          <p className="font-medium">No webhook endpoints yet</p>
          <p className="text-sm mt-1">Add an endpoint to receive real-time event notifications.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {endpoints.map((ep) => (
            <div
              key={ep.id}
              className={`rounded-xl border p-5 bg-white dark:bg-gray-900 transition-colors ${
                ep.enabled
                  ? "border-gray-200 dark:border-gray-700"
                  : "border-gray-100 dark:border-gray-800 opacity-60"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        ep.enabled
                          ? "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300"
                          : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {ep.enabled ? "Active" : "Paused"}
                    </span>
                    {ep.id === newEndpointId && (
                      <span className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">
                        New — save your signing secret above
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm font-mono text-gray-700 dark:text-gray-200 truncate">
                    {ep.url}
                  </p>
                  {ep.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{ep.description}</p>
                  )}
                  {ep.event_types.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {ep.event_types.map((t) => (
                        <span
                          key={t}
                          className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-800 rounded-full text-gray-600 dark:text-gray-400"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400 mt-1">Receives all event types</p>
                  )}
                  {ep.last_error && (
                    <p className="text-xs text-red-500 mt-1 truncate">
                      Last error: {ep.last_error}
                    </p>
                  )}
                </div>

                {isAdmin && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleTest(ep.id)}
                      disabled={testing === ep.id}
                      className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                    >
                      {testing === ep.id ? "Sending…" : "Test"}
                    </button>
                    <button
                      onClick={() => handleToggle(ep.id, !ep.enabled)}
                      className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      {ep.enabled ? "Pause" : "Enable"}
                    </button>
                    <button
                      onClick={() => handleDelete(ep.id)}
                      className="px-3 py-1.5 text-xs border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Documentation */}
      <div className="mt-10 rounded-xl bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
          Verifying webhook signatures
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Each delivery includes a <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">X-GrainGuard-Signature</code> header.
          Verify it to ensure the payload came from GrainGuard.
        </p>
        <pre className="text-xs bg-gray-100 dark:bg-gray-800 rounded-lg p-4 overflow-x-auto text-gray-700 dark:text-gray-300">{`// Node.js / Express
const crypto = require("crypto");

function verifySignature(rawBody, header, secret) {
  const [tPart, v1Part] = header.split(",");
  const timestamp = tPart.replace("t=", "");
  const signature = v1Part.replace("v1=", "");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(\`\${timestamp}.\${rawBody}\`)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}`}</pre>
      </div>
    </div>
  );
}
