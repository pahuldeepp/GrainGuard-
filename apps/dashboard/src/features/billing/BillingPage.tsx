import { useEffect, useState } from "react";
import { getAccessTokenSilently } from "../../lib/auth0";

// Shape returned by GET /billing/subscription
interface Subscription {
  plan: string;
  subscription_status: string;   // 'trialing' | 'active' | 'past_due' | 'canceled'
  trial_ends_at: string | null;  // ISO 8601
  current_period_end: string | null;
}

// Plans exposed in the UI — must match PLANS keys in gateway/src/services/stripe.ts
const PLANS = [
  {
    key: "starter",
    label: "Starter",
    price: "$49/mo",
    devices: "Up to 10 devices",
    features: ["Real-time telemetry", "7-day data retention", "Email support"],
  },
  {
    key: "professional",
    label: "Professional",
    price: "$199/mo",
    devices: "Up to 100 devices",
    features: ["Real-time telemetry", "90-day data retention", "Priority support", "CSV export"],
  },
  {
    key: "enterprise",
    label: "Enterprise",
    price: "Custom",
    devices: "Unlimited devices",
    features: ["Everything in Pro", "SLA guarantee", "Dedicated support", "SSO / SAML"],
  },
] as const;

type PlanKey = (typeof PLANS)[number]["key"];

const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? "";

export function BillingPage() {
  const [sub, setSub]         = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<PlanKey | null>(null); // which plan button is spinning

  // Load current subscription on mount
  useEffect(() => {
    async function loadSub() {
      try {
        const token = await getAccessTokenSilently();
        const res = await fetch(`${GATEWAY}/billing/subscription`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSub(await res.json());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load subscription");
      } finally {
        setLoading(false);
      }
    }
    loadSub();
  }, []);

  // Called when user clicks "Upgrade" on a plan card
  async function handleUpgrade(plan: PlanKey) {
    setUpgrading(plan);   // show spinner on that specific button
    try {
      const token = await getAccessTokenSilently();
      const res = await fetch(`${GATEWAY}/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const { url } = await res.json();
      // Redirect browser to Stripe Checkout — Stripe hosts the card form
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
      setUpgrading(null);
    }
  }

  // ── Status badge helper ────────────────────────────────────────────────────
  function StatusBadge({ status }: { status: string }) {
    const colors: Record<string, string> = {
      active:   "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
      trialing: "bg-blue-100  text-blue-800  dark:bg-blue-900  dark:text-blue-300",
      past_due: "bg-red-100   text-red-800   dark:bg-red-900   dark:text-red-300",
      canceled: "bg-gray-100  text-gray-600  dark:bg-gray-800  dark:text-gray-400",
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? colors.canceled}`}>
        {status}
      </span>
    );
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        Loading billing info…
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Billing</h1>

      {/* Error banner */}
      {error && (
        <div role="alert" className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200
                                      dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Current subscription summary */}
      {sub && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow p-6 mb-8">
          <div className="flex flex-wrap gap-4 items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Current plan</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white capitalize mt-1">
                {sub.plan}
              </p>
            </div>
            <StatusBadge status={sub.subscription_status} />
          </div>

          {/* Trial expiry notice */}
          {sub.trial_ends_at && (
            <p className="mt-4 text-sm text-blue-600 dark:text-blue-400">
              Trial ends {new Date(sub.trial_ends_at).toLocaleDateString()}
            </p>
          )}

          {/* Next billing date */}
          {sub.current_period_end && sub.subscription_status === "active" && (
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Next billing date: {new Date(sub.current_period_end).toLocaleDateString()}
            </p>
          )}
        </div>
      )}

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {PLANS.map((plan) => {
          const isCurrent = sub?.plan === plan.key;

          return (
            <div
              key={plan.key}
              className={`bg-white dark:bg-gray-900 rounded-xl shadow p-6 flex flex-col
                          ${isCurrent ? "ring-2 ring-green-500" : ""}`}
            >
              {/* Plan header */}
              <div className="mb-4">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                  {plan.label}
                </h2>
                <p className="text-2xl font-bold text-green-600 mt-1">{plan.price}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{plan.devices}</p>
              </div>

              {/* Feature list */}
              <ul className="flex-1 space-y-2 mb-6">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <span className="text-green-500 mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              {/* CTA button */}
              {isCurrent ? (
                <span className="text-center text-sm text-green-600 font-medium py-2">
                  Current plan
                </span>
              ) : plan.key === "enterprise" ? (
                // Enterprise doesn't go through Stripe Checkout — contact sales
                <a
                  href="mailto:sales@grainguard.io?subject=Enterprise+Plan"
                  className="block text-center px-4 py-2 bg-gray-900 dark:bg-white
                             text-white dark:text-gray-900 rounded-lg text-sm font-medium
                             hover:opacity-90 transition-opacity"
                >
                  Contact Sales
                </a>
              ) : (
                <button
                  onClick={() => handleUpgrade(plan.key)}
                  disabled={upgrading !== null}  // disable all buttons while one is loading
                  className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium
                             hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed
                             flex items-center justify-center gap-2 transition-colors"
                >
                  {upgrading === plan.key && (
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white
                                     rounded-full animate-spin" />
                  )}
                  {upgrading === plan.key ? "Redirecting…" : "Upgrade"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
