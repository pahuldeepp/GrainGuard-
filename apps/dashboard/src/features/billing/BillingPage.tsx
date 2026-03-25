import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../../lib/apiFetch";
import toast from "react-hot-toast";

type Plan = {
  key: string;
  name: string;
  price: string;
  devices: string;
  features: readonly string[];
  highlighted?: boolean;
};

const PLANS: Plan[] = [
  {
    key:      "starter",
    name:     "Starter",
    price:    "$29/mo",
    devices:  "Up to 10 devices",
    features: ["Real-time telemetry", "7-day history", "Email alerts"],
  },
  {
    key:         "professional",
    name:        "Professional",
    price:       "$99/mo",
    devices:     "Up to 100 devices",
    features:    ["Everything in Starter", "30-day history", "Slack alerts", "CSV export", "API access"],
    highlighted: true,
  },
  {
    key:      "enterprise",
    name:     "Enterprise",
    price:    "Custom",
    devices:  "Unlimited devices",
    features: ["Everything in Professional", "1-year history", "SSO/SAML", "SLA", "Dedicated support"],
  },
];

type Subscription = {
  plan: string;
  status: string;
  trialEndsAt: string | null;
  currentPeriodEnd: number | null;   // Unix timestamp from Stripe
  cancelAtPeriodEnd: boolean;
  paymentFailed: boolean;
};

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  active:   { label: "Active",          className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" },
  trialing: { label: "Trial",           className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300" },
  past_due: { label: "Payment overdue", className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300" },
  cancelled:{ label: "Cancelled",       className: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300" },
  none:     { label: "Free",            className: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400" },
};

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
}

export function BillingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subLoading,   setSubLoading]   = useState(true);
  const [loading,      setLoading]      = useState<string | null>(null);

  // Show success banner if redirected from Stripe checkout
  const checkoutSuccess = searchParams.get("success") === "1";

  useEffect(() => {
    if (checkoutSuccess) {
      toast.success("Subscription activated! Welcome aboard.");
      // Clear the query param without reloading
      setSearchParams({}, { replace: true });
    }
  }, [checkoutSuccess]);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch("/billing/subscription");
        setSubscription(data as Subscription);
      } catch {
        // Non-fatal — page still usable without subscription info
      } finally {
        setSubLoading(false);
      }
    })();
  }, []);

  const handleUpgrade = async (plan: string) => {
    if (plan === "enterprise") {
      window.location.href = "mailto:sales@grainguard.com?subject=Enterprise Plan";
      return;
    }
    setLoading(plan);
    try {
      const { url } = await apiFetch("/billing/checkout", {
        method: "POST",
        body:   JSON.stringify({ plan }),
      }) as { url: string };
      window.location.href = url;
    } catch {
      toast.error("Failed to start checkout. Please try again.");
    } finally {
      setLoading(null);
    }
  };

  const handleManageBilling = async () => {
    try {
      const { url } = await apiFetch("/billing/portal", { method: "POST" }) as { url: string };
      window.location.href = url;
    } catch {
      toast.error("Could not open billing portal. Please try again.");
    }
  };

  const statusInfo    = STATUS_LABELS[subscription?.status ?? "none"] ?? STATUS_LABELS.none;
  const activePlanKey = subscription?.plan ?? "free";

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">

      {/* Success banner */}
      {checkoutSuccess && (
        <div className="mb-6 flex items-center gap-3 rounded-xl bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 px-5 py-4">
          <span className="text-green-600 text-xl">✓</span>
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            Your subscription is now active. Thank you!
          </p>
        </div>
      )}

      {/* Payment failure warning */}
      {subscription?.paymentFailed && (
        <div className="mb-6 flex items-center gap-3 rounded-xl bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 px-5 py-4">
          <span className="text-red-600 text-xl">⚠</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800 dark:text-red-300">
              Your last payment failed. Please update your payment method to keep your subscription active.
            </p>
          </div>
          <button
            onClick={handleManageBilling}
            className="shrink-0 text-sm font-medium text-red-700 dark:text-red-300 underline hover:no-underline"
          >
            Fix now
          </button>
        </div>
      )}

      <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Billing & Plans</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
            Choose the plan that fits your operation.
          </p>
        </div>

        {/* Current plan summary */}
        {!subLoading && subscription && subscription.status !== "none" && (
          <div className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 text-sm">
            <div>
              <span className="font-semibold text-gray-900 dark:text-white capitalize">{activePlanKey}</span>
              <span
                className={`ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.className}`}
              >
                {statusInfo.label}
              </span>
            </div>
            {subscription.currentPeriodEnd && !subscription.cancelAtPeriodEnd && (
              <span className="text-gray-400">
                Renews {formatDate(subscription.currentPeriodEnd)}
              </span>
            )}
            {subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd && (
              <span className="text-orange-500">
                Cancels {formatDate(subscription.currentPeriodEnd)}
              </span>
            )}
            {subscription.trialEndsAt && (
              <span className="text-blue-500">
                Trial ends {new Date(subscription.trialEndsAt).toLocaleDateString()}
              </span>
            )}
            <button
              onClick={handleManageBilling}
              className="ml-2 text-gray-500 hover:text-green-600 dark:hover:text-green-400 underline text-xs"
            >
              Manage
            </button>
          </div>
        )}
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {PLANS.map((plan) => {
          const isCurrent = plan.key === activePlanKey;
          return (
            <div
              key={plan.key}
              className={`relative rounded-xl border p-6 flex flex-col ${
                plan.highlighted
                  ? "border-green-500 shadow-lg shadow-green-100 dark:shadow-none"
                  : "border-gray-200 dark:border-gray-700"
              } bg-white dark:bg-gray-900`}
            >
              {plan.highlighted && !isCurrent && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-green-600 text-white text-xs font-semibold px-3 py-1 rounded-full">
                    Most popular
                  </span>
                </div>
              )}
              {isCurrent && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-900 text-xs font-semibold px-3 py-1 rounded-full">
                    Current plan
                  </span>
                </div>
              )}
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{plan.name}</h2>
                <div className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{plan.price}</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">{plan.devices}</div>
              </div>
              <ul className="space-y-2 mb-6 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <span className="text-green-600 mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => handleUpgrade(plan.key)}
                disabled={loading === plan.key || isCurrent}
                className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isCurrent
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-default"
                    : plan.highlighted
                    ? "bg-green-600 text-white hover:bg-green-700"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {loading === plan.key
                  ? "Redirecting..."
                  : isCurrent
                  ? "Current plan"
                  : plan.key === "enterprise"
                  ? "Contact Sales"
                  : "Upgrade"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}