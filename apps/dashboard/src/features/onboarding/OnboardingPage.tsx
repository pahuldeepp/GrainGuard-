import { useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { useTenantContext } from "../tenancy/TenantContext";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "http://localhost:3000";

export function OnboardingPage() {
  const { user, getAccessTokenSilently } = useAuth0();
  const navigate = useNavigate();
  const { setActiveTenant } = useTenantContext();
  const [orgName, setOrgName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const token = await getAccessTokenSilently();
      const res = await fetch(`${GATEWAY_URL}/tenants/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orgName: orgName.trim(),
          email: user?.email,
          authUserId: user?.sub,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Registration failed");
      }

      const { tenantId } = await res.json();
      setActiveTenant(tenantId);
      toast.success("Organisation created! Welcome to GrainGuard.");
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 justify-center mb-8">
          <div className="w-10 h-10 bg-green-600 rounded-xl flex items-center justify-center">
            <span className="text-white font-bold text-lg">G</span>
          </div>
          <span className="text-2xl font-bold text-gray-900 dark:text-white">GrainGuard</span>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-8">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-1">
            Set up your organisation
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            You're logged in as <strong>{user?.email}</strong>. Let's create your workspace.
          </p>

          <form onSubmit={handleSubmit}>
            <label
              htmlFor="org-name"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Organisation name
            </label>
            <input
              id="org-name"
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="e.g. Prairie Gold Grain Co."
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 mb-4"
              disabled={loading}
              autoFocus
            />

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !orgName.trim()}
              className="w-full py-2 px-4 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Creating..." : "Create Organisation"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 dark:text-gray-600 mt-4">
          You can add team members and register devices after setup.
        </p>
      </div>
    </div>
  );
}
