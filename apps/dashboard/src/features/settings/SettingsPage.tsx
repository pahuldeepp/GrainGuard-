import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/apiFetch";
import { getAccessTokenSilently } from "../../lib/auth0";
import { useAuth } from "../../hooks/useAuth";
import toast from "react-hot-toast";

const GW = import.meta.env.VITE_GATEWAY_URL ?? "";

interface AccountInfo {
  user: { id: string; email: string; role: string; created_at: string } | null;
  tenant: { id: string; name: string; slug: string; plan: string; subscription_status: string; created_at: string } | null;
  deviceCount: number;
  roles: string[];
}

interface NotifPrefs {
  email_alerts:        boolean;
  email_weekly_digest: boolean;
  webhook_alerts:      boolean;
  alert_levels:        string[];
}

type TogglePrefKey = "email_alerts" | "email_weekly_digest" | "webhook_alerts";

const TOGGLE_PREFS: Array<{ key: TogglePrefKey; label: string; desc: string }> = [
  {
    key: "email_alerts",
    label: "Email alerts",
    desc: "Receive an email when a device triggers a warning or critical alert.",
  },
  {
    key: "email_weekly_digest",
    label: "Weekly digest email",
    desc: "Weekly summary of device health and alert activity.",
  },
  {
    key: "webhook_alerts",
    label: "Webhook alerts",
    desc: "POST alert events to your registered webhook endpoints.",
  },
];

export function SettingsPage() {
  const { user: authUser, signOut } = useAuth();
  const [account,     setAccount]     = useState<AccountInfo | null>(null);
  const [notifPrefs,  setNotifPrefs]  = useState<NotifPrefs | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [deleting,    setDeleting]    = useState(false);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    try {
      const [acct, prefs] = await Promise.all([
        apiFetch("/account/me"),
        apiFetch("/notifications/preferences"),
      ]);
      setAccount(acct);
      setNotifPrefs(prefs);
    } catch {
      toast.error("Failed to load account info");
    } finally {
      setLoading(false);
    }
  }

  async function handleSavePrefs(patch: Partial<NotifPrefs>) {
    if (!notifPrefs) return;
    const updated = { ...notifPrefs, ...patch };
    setNotifPrefs(updated);
    setSavingPrefs(true);
    try {
      const saved = await apiFetch("/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify({
          emailAlerts:       updated.email_alerts,
          emailWeeklyDigest: updated.email_weekly_digest,
          webhookAlerts:     updated.webhook_alerts,
          alertLevels:       updated.alert_levels,
        }),
      });
      setNotifPrefs(saved);
      toast.success("Preferences saved");
    } catch {
      toast.error("Failed to save preferences");
      setNotifPrefs(notifPrefs); // revert
    } finally {
      setSavingPrefs(false);
    }
  }

  function handleTogglePref(key: TogglePrefKey) {
    if (!notifPrefs) return;
    handleSavePrefs({ [key]: !notifPrefs[key] } as Pick<NotifPrefs, TogglePrefKey>);
  }

  async function handleExport() {
    try {
      const token = await getAccessTokenSilently();
      const res = await fetch(`${GW}/account/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body?.error === "string" ? body.error : `HTTP ${res.status}`
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("content-disposition") ?? "";
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/i);
      a.download = filenameMatch?.[1] ?? `grainguard-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Data exported");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    }
  }

  async function handleDeleteAccount() {
    const confirmed = confirm(
      "Are you sure you want to delete your account? This action cannot be undone. All your data will be permanently deleted."
    );
    if (!confirmed) return;

    const doubleConfirm = confirm(
      "This will permanently delete all devices, alert rules, audit logs, and team data. Type OK to confirm."
    );
    if (!doubleConfirm) return;

    setDeleting(true);
    try {
      const result = await apiFetch("/account/me", { method: "DELETE" });
      toast.success(result.message);
      setTimeout(() => signOut(), 2000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete account");
    } finally {
      setDeleting(false);
    }
  }

  const planLabels: Record<string, string> = {
    free: "Free",
    starter: "Starter",
    professional: "Professional",
    enterprise: "Enterprise",
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto">
        <div className="text-gray-500 dark:text-gray-400 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Settings</h1>

      {/* Profile Section */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Profile</h2>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Email</span>
            <span className="text-gray-900 dark:text-white font-medium">{authUser?.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Role</span>
            <span className="text-gray-900 dark:text-white font-medium capitalize">
              {account?.user?.role || "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Member since</span>
            <span className="text-gray-900 dark:text-white font-medium">
              {account?.user?.created_at
                ? new Date(account.user.created_at).toLocaleDateString()
                : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Organisation Section */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Organisation</h2>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Name</span>
            <span className="text-gray-900 dark:text-white font-medium">
              {account?.tenant?.name || "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Plan</span>
            <span className="text-gray-900 dark:text-white font-medium">
              {planLabels[account?.tenant?.plan || "free"] || account?.tenant?.plan}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Subscription</span>
            <span className="text-gray-900 dark:text-white font-medium capitalize">
              {account?.tenant?.subscription_status || "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Devices</span>
            <span className="text-gray-900 dark:text-white font-medium">
              {account?.deviceCount ?? 0}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Tenant ID</span>
            <span className="text-gray-500 dark:text-gray-400 font-mono text-xs">
              {account?.tenant?.id || "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Notification Preferences */}
      {notifPrefs && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Notification Preferences
          </h2>
          <div className="space-y-4">
            {/* Email toggles */}
            {TOGGLE_PREFS.map(({ key, label, desc }) => (
              <div key={key} className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{label}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{desc}</p>
                </div>
                <button
                  disabled={savingPrefs}
                  onClick={() => handleTogglePref(key)}
                  className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                    notifPrefs[key]
                      ? "bg-green-600"
                      : "bg-gray-300 dark:bg-gray-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      notifPrefs[key] ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            ))}

            {/* Alert level filter */}
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">
                Alert severity to notify on
              </p>
              <div className="flex gap-2">
                {(["warn", "critical"] as const).map((lvl) => {
                  const active = notifPrefs.alert_levels.includes(lvl);
                  return (
                    <button
                      key={lvl}
                      disabled={savingPrefs}
                      onClick={() => {
                        const levels = active
                          ? notifPrefs.alert_levels.filter((l) => l !== lvl)
                          : [...notifPrefs.alert_levels, lvl];
                        if (levels.length === 0) return; // must keep at least one
                        handleSavePrefs({ alert_levels: levels });
                      }}
                      className={`px-3 py-1.5 text-xs rounded-full border font-medium transition-colors ${
                        active
                          ? lvl === "critical"
                            ? "bg-red-100 border-red-400 text-red-800 dark:bg-red-900/50 dark:text-red-300"
                            : "bg-yellow-100 border-yellow-400 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300"
                          : "bg-gray-100 border-gray-300 text-gray-500 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-400"
                      }`}
                    >
                      {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-400 mt-1.5">
                You must keep at least one level selected.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Data & Privacy Section */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Data & Privacy</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Export all your data or delete your account permanently.
        </p>
        <div className="flex gap-3">
          <button
            onClick={handleExport}
            className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            Export My Data
          </button>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-red-700 dark:text-red-400 mb-2">Danger Zone</h2>
        <p className="text-sm text-red-600 dark:text-red-400 mb-4">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>
        <button
          onClick={handleDeleteAccount}
          disabled={deleting}
          className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Delete Account"}
        </button>
      </div>
    </div>
  );
}
