import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/apiFetch";

type ConnectionType = "saml" | "oidc";

interface SSOState {
  configured: boolean;
  orgId?: string;
  connections: Array<{ connection_id: string; display_name: string }>;
}

export function SSOPage() {
  const [state, setState]     = useState<SSOState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ConnectionType>("saml");

  // SAML form fields
  const [samlForm, setSamlForm] = useState({ name: "", signInUrl: "", signingCert: "", emailDomains: "" });
  // OIDC form fields
  const [oidcForm, setOidcForm] = useState({ name: "", discoveryUrl: "", clientId: "", clientSecret: "", emailDomains: "" });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess]   = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch("/tenants/me/sso");
      setState(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load SSO settings");
    } finally {
      setLoading(false);
    }
  }

  async function ensureOrg() {
    await apiFetch("/tenants/me/sso/org", { method: "POST" });
    await load();
  }

  async function configureSaml(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      if (!state?.orgId) await ensureOrg();
      const result = await apiFetch("/tenants/me/sso/saml", {
        method: "POST",
        body: JSON.stringify({
          name:         samlForm.name,
          signInUrl:    samlForm.signInUrl,
          signingCert:  samlForm.signingCert,
          emailDomains: samlForm.emailDomains.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      setSuccess(`SAML configured. Your ACS URL: ${result.acsUrl}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to configure SAML");
    } finally {
      setSubmitting(false);
    }
  }

  async function configureOidc(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      if (!state?.orgId) await ensureOrg();
      await apiFetch("/tenants/me/sso/oidc", {
        method: "POST",
        body: JSON.stringify({
          name:         oidcForm.name,
          discoveryUrl: oidcForm.discoveryUrl,
          clientId:     oidcForm.clientId,
          clientSecret: oidcForm.clientSecret,
          emailDomains: oidcForm.emailDomains.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      setSuccess("OIDC connection configured successfully.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to configure OIDC");
    } finally {
      setSubmitting(false);
    }
  }

  async function disableSSO() {
    if (!confirm("Disable SSO? Users will fall back to username/password login.")) return;
    try {
      await apiFetch("/tenants/me/sso", { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disable SSO");
    }
  }

  if (loading) return <div className="p-8 text-gray-500 dark:text-gray-400">Loading SSO settings…</div>;

  const inputCls = "w-full px-3 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500";
  const labelCls = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Single Sign-On (SSO)</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-6">
        Connect your identity provider. Users from your domain will be redirected to your IdP automatically.
      </p>

      {error && <div role="alert" className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">{error}</div>}
      {success && <div role="status" className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-green-700 dark:text-green-400 text-sm break-all">{success}</div>}

      <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-5 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-gray-900 dark:text-white">Status</p>
            <p className={`text-sm mt-1 ${state?.configured ? "text-green-600" : "text-gray-500 dark:text-gray-400"}`}>
              {state?.configured ? `SSO enabled — ${state.connections.length} connection(s)` : "Not configured"}
            </p>
          </div>
          {state?.configured && (
            <button onClick={disableSSO} className="px-3 py-1.5 text-xs border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20">
              Disable SSO
            </button>
          )}
        </div>
      </div>

      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6">
        {(["saml", "oidc"] as ConnectionType[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors
              ${activeTab === tab
                ? "border-green-600 text-green-600"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
          >
            {tab.toUpperCase()}
          </button>
        ))}
      </div>

      {activeTab === "saml" && (
        <form onSubmit={configureSaml} className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Use for Okta, ADFS, Ping Identity, or any SAML 2.0 provider.
          </p>
          <div><label className={labelCls}>Connection Name</label><input className={inputCls} value={samlForm.name} onChange={(e) => setSamlForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Acme Okta" required /></div>
          <div><label className={labelCls}>IdP Single Sign-On URL</label><input className={inputCls} type="url" value={samlForm.signInUrl} onChange={(e) => setSamlForm(f => ({ ...f, signInUrl: e.target.value }))} placeholder="https://acme.okta.com/app/xxx/sso/saml" required /></div>
          <div>
            <label className={labelCls}>IdP X.509 Signing Certificate (PEM, base64)</label>
            <textarea className={`${inputCls} font-mono h-28`} value={samlForm.signingCert} onChange={(e) => setSamlForm(f => ({ ...f, signingCert: e.target.value }))} placeholder="MIIDpDCCAoygAwIBAgIGAV..." required />
          </div>
          <div><label className={labelCls}>Email Domains (comma-separated)</label><input className={inputCls} value={samlForm.emailDomains} onChange={(e) => setSamlForm(f => ({ ...f, emailDomains: e.target.value }))} placeholder="acme.com, acme.io" required /></div>
          <button type="submit" disabled={submitting} className="w-full py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {submitting && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {submitting ? "Configuring…" : "Save SAML Connection"}
          </button>
        </form>
      )}

      {activeTab === "oidc" && (
        <form onSubmit={configureOidc} className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Use for Azure AD, Google Workspace, Keycloak, or any OpenID Connect provider.
          </p>
          <div><label className={labelCls}>Connection Name</label><input className={inputCls} value={oidcForm.name} onChange={(e) => setOidcForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Acme Azure AD" required /></div>
          <div><label className={labelCls}>OIDC Discovery URL</label><input className={inputCls} type="url" value={oidcForm.discoveryUrl} onChange={(e) => setOidcForm(f => ({ ...f, discoveryUrl: e.target.value }))} placeholder="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" required /></div>
          <div><label className={labelCls}>Client ID</label><input className={inputCls} value={oidcForm.clientId} onChange={(e) => setOidcForm(f => ({ ...f, clientId: e.target.value }))} required /></div>
          <div><label className={labelCls}>Client Secret</label><input className={inputCls} type="password" value={oidcForm.clientSecret} onChange={(e) => setOidcForm(f => ({ ...f, clientSecret: e.target.value }))} required /></div>
          <div><label className={labelCls}>Email Domains (comma-separated)</label><input className={inputCls} value={oidcForm.emailDomains} onChange={(e) => setOidcForm(f => ({ ...f, emailDomains: e.target.value }))} placeholder="acme.com" required /></div>
          <button type="submit" disabled={submitting} className="w-full py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {submitting && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {submitting ? "Configuring…" : "Save OIDC Connection"}
          </button>
        </form>
      )}
    </div>
  );
}
