import { useState } from "react";
import { getAccessTokenSilently } from "../../lib/auth0";
import toast from "react-hot-toast";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "http://localhost:3000";

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
    key: "starter",
    name: "Starter",
    price: "$29/mo",
    devices: "Up to 10 devices",
    features: ["Real-time telemetry", "7-day history", "Email alerts"],
  },
  {
    key: "professional",
    name: "Professional",
    price: "$99/mo",
    devices: "Up to 100 devices",
    features: ["Everything in Starter", "30-day history", "Slack alerts", "CSV export", "API access"],
    highlighted: true,
  },
  {
    key: "enterprise",
    name: "Enterprise",
    price: "Custom",
    devices: "Unlimited devices",
    features: ["Everything in Professional", "1-year history", "SSO/SAML", "SLA", "Dedicated support"],
  },
];

export function BillingPage() {
  const [loading, setLoading] = useState<string | null>(null);

  const handleUpgrade = async (plan: string) => {
    if (plan === "enterprise") {
      window.location.href = "mailto:sales@grainguard.io?subject=Enterprise Plan";
      return;
    }
    setLoading(plan);
    try {
      const token = await getAccessTokenSilently();
      const res = await fetch(`${GATEWAY_URL}/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok) throw new Error("Failed to create checkout session");
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      toast.error("Failed to start checkout. Please try again.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Billing & Plans</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
          Choose the plan that fits your operation.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {PLANS.map((plan) => (
          <div
            key={plan.key}
            className={`relative rounded-xl border p-6 flex flex-col ${
              plan.highlighted
                ? "border-green-500 shadow-lg shadow-green-100 dark:shadow-none"
                : "border-gray-200 dark:border-gray-700"
            } bg-white dark:bg-gray-900`}
          >
            {plan.highlighted && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="bg-green-600 text-white text-xs font-semibold px-3 py-1 rounded-full">
                  Most popular
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
              disabled={loading === plan.key}
              className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                plan.highlighted
                  ? "bg-green-600 text-white hover:bg-green-700"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {loading === plan.key ? "Redirecting..." : plan.key === "enterprise" ? "Contact Sales" : "Upgrade"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
