import { useEffect } from "react";
import { ApolloProvider } from "@apollo/client/react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { useAuth0 } from "@auth0/auth0-react";
import client from "./lib/apollo";
import { setGetAccessTokenSilently } from "./lib/auth0";
import { DevicesPage } from "./features/devices/components/DevicesPage";
import { DeviceDetailPage } from "./features/devices/components/DeviceDetailPage";
import { BillingPage } from "./features/billing/BillingPage";
import { OnboardingPage } from "./features/onboarding/OnboardingPage";
import { SSOPage } from "./features/sso/SSOPage";
import { AlertRulesPage } from "./features/alerts/AlertRulesPage";
import { AuditLogPage } from "./features/audit/AuditLogPage";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import { NotFound } from "./shared/components/NotFound";
import { ProtectedRoute } from "./features/auth/ProtectedRoute";
import { TenantProvider } from "./features/tenancy/TenantContext";
import { TenantSwitcher } from "./features/tenancy/components/TenantSwitcher";
import { useDarkMode } from "./hooks/useDarkMode";
import { useAuth } from "./hooks/useAuth";

function AppInner() {
  const { isDark, toggle } = useDarkMode();
  const { user, signOut, isAuthenticated } = useAuth();
  const { getAccessTokenSilently } = useAuth0();

  useEffect(() => {
    setGetAccessTokenSilently(getAccessTokenSilently);
  }, [getAccessTokenSilently]);

  return (
    <BrowserRouter>
      <TenantProvider>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
          <nav className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 md:px-6 py-4">
            <div className="max-w-7xl mx-auto flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center shrink-0">
                  <span className="text-white text-sm font-bold">G</span>
                </div>
                <span className="text-lg font-bold text-gray-900 dark:text-white">
                  GrainGuard
                </span>
              </div>
              <div className="flex items-center gap-3 md:gap-4 text-sm">
                {isAuthenticated && (
                  <Link to="/" className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
                    Devices
                  </Link>
                )}
                {isAuthenticated && (
                  <Link to="/billing" className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">Billing</Link>
                )}
                {isAuthenticated && (
                  <Link to="/alerts" className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">Alerts</Link>
                )}
                {isAuthenticated && (
                  <Link to="/audit" className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">Audit</Link>
                )}
                {isAuthenticated && (
                  <Link to="/sso" className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">SSO</Link>
                )}
                {isAuthenticated && <TenantSwitcher />}
                <button
                  onClick={toggle}
                  aria-label="Toggle dark mode"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  {isDark ? "☀️" : "🌙"}
                </button>
                {isAuthenticated && (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:block">
                      {user?.email}
                    </span>
                    <button
                      onClick={signOut}
                      className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </div>
          </nav>
          <ErrorBoundary>
            <ProtectedRoute>
              <Routes>
                <Route path="/" element={<DevicesPage />} />
                <Route path="/devices/:id" element={<DeviceDetailPage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/billing/success" element={<BillingPage />} />
                <Route path="/onboarding" element={<OnboardingPage />} />
                <Route path="/sso" element={<SSOPage />} />
                <Route path="/alerts" element={<AlertRulesPage />} />
                <Route path="/audit" element={<AuditLogPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </ProtectedRoute>
          </ErrorBoundary>
        </div>
        <Toaster
          position="bottom-right"
          toastOptions={{
            duration: 4000,
            style: { fontSize: "14px" },
            success: { iconTheme: { primary: "#16a34a", secondary: "#fff" } },
            error: { duration: 6000 },
          }}
        />
      </TenantProvider>
    </BrowserRouter>
  );
}

function App() {
  return (
    <ApolloProvider client={client}>
      <AppInner />
    </ApolloProvider>
  );
}

export default App;
