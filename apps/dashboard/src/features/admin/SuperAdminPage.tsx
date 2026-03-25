import { useEffect, useState } from "react";
import { getAccessTokenSilently } from "../../lib/auth0";
import { useAuth } from "../../hooks/useAuth";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  subscription_status: string;
  device_count: number;
  member_count: number;
  created_at: string;
}

const GW = import.meta.env.VITE_GATEWAY_URL ?? "";

export function SuperAdminPage() {
  const { isSuperAdmin } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!isSuperAdmin) return;
    (async () => {
      try {
        const token = await getAccessTokenSilently();
        const res = await fetch(`${GW}/admin/tenants`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) setTenants(await res.json());
      } catch (e) {
        console.error("Failed to load tenants:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [isSuperAdmin]);

  if (!isSuperAdmin) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center">
        <h1 className="text-xl font-bold text-red-600">Access Denied</h1>
        <p className="text-gray-500 mt-2">This page is restricted to super administrators.</p>
      </div>
    );
  }

  const filtered = tenants.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.slug.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Super Admin — Tenants</h1>
        <span className="text-sm text-gray-500">{tenants.length} total</span>
      </div>

      <input
        type="text"
        placeholder="Search tenants..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-sm mb-4 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
      />

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-400">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Slug</th>
                <th className="text-left px-4 py-3 font-medium">Plan</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Devices</th>
                <th className="text-right px-4 py-3 font-medium">Members</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{t.name}</td>
                  <td className="px-4 py-3 text-gray-500">{t.slug}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                      {t.plan || "free"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{t.subscription_status || "none"}</td>
                  <td className="px-4 py-3 text-right text-gray-900 dark:text-white">{t.device_count}</td>
                  <td className="px-4 py-3 text-right text-gray-900 dark:text-white">{t.member_count}</td>
                  <td className="px-4 py-3 text-gray-500">{new Date(t.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    No tenants found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
