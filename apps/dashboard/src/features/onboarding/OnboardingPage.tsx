import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAccessTokenSilently } from "../../lib/auth0";

// ── Steps ─────────────────────────────────────────────────────────────────────
// The onboarding wizard walks new users through three steps:
//   1. Name their organisation (creates the tenant row)
//   2. Register their first device (optional but encouraged)
//   3. Choose a billing plan (redirects to Stripe Checkout)

type Step = "org" | "device" | "billing";

const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? "";

// Serial number validation — must match gateway's createDeviceSchema
const SERIAL_RE = /^[A-Z0-9]{4,30}$/;

export function OnboardingPage() {
  const navigate = useNavigate();

  const [step, setStep]       = useState<Step>("org");
  const [orgName, setOrgName] = useState("");
  const [serial, setSerial]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // ── Step 1: Create Organisation ──────────────────────────────────────────
  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();

    if (orgName.trim().length < 2) {
      setError("Organisation name must be at least 2 characters");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const token = await getAccessTokenSilently();

      // POST /tenants is the registration endpoint — creates the tenant row
      // and links the Auth0 user as the first admin via tenant_users
      const res = await fetch(`${GATEWAY}/tenants`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: orgName.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      setStep("device");  // move to step 2 on success
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organisation");
    } finally {
      setLoading(false);
    }
  }

  // ── Step 2: Register First Device (optional) ─────────────────────────────
  async function handleRegisterDevice(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = serial.trim().toUpperCase();

    if (trimmed && !SERIAL_RE.test(trimmed)) {
      setError("Serial number must be 4–30 uppercase letters or digits");
      return;
    }

    if (trimmed) {
      setLoading(true);
      setError(null);

      try {
        const token = await getAccessTokenSilently();
        const res = await fetch(`${GATEWAY}/devices`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ serialNumber: trimmed }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to register device");
        setLoading(false);
        return;
      } finally {
        setLoading(false);
      }
    }

    // Whether or not they registered a device, move to billing step
    setStep("billing");
  }

  // ── Step 3: Choose a plan ─────────────────────────────────────────────────
  async function handleChoosePlan(plan: "starter" | "professional") {
    setLoading(true);
    setError(null);

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
      window.location.href = url;   // redirect to Stripe Checkout
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
      setLoading(false);
    }
  }

  // ── Step indicator ────────────────────────────────────────────────────────
  const STEPS: { key: Step; label: string }[] = [
    { key: "org",     label: "Organisation" },
    { key: "device",  label: "First Device" },
    { key: "billing", label: "Choose Plan" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <div className="w-12 h-12 bg-green-600 rounded-xl flex items-center justify-center">
            <span className="text-white text-xl font-bold">G</span>
          </div>
        </div>

        {/* Step dots */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
                  ${step === s.key
                    ? "bg-green-600 text-white"
                    : STEPS.indexOf(STEPS.find(x => x.key === step)!) > i
                      ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                      : "bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                  }`}
              >
                {i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className="w-8 h-0.5 bg-gray-200 dark:bg-gray-700" />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg p-8">

          {/* Error banner */}
          {error && (
            <div role="alert"
                 className="mb-6 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200
                            dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* ── Step 1: Org name ── */}
          {step === "org" && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Welcome to GrainGuard
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mb-6">
                Let's start by creating your organisation.
              </p>
              <form onSubmit={handleCreateOrg}>
                <label
                  htmlFor="org-name"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  Organisation Name
                </label>
                <input
                  id="org-name"
                  type="text"
                  autoFocus
                  value={orgName}
                  onChange={(e) => { setOrgName(e.target.value); setError(null); }}
                  placeholder="e.g. Acme Grain Co."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700
                             bg-white dark:bg-gray-800 text-gray-900 dark:text-white
                             rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <button
                  type="submit"
                  disabled={loading || orgName.trim().length < 2}
                  className="mt-4 w-full py-2 bg-green-600 text-white rounded-lg font-medium
                             hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed
                             flex items-center justify-center gap-2"
                >
                  {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  {loading ? "Creating…" : "Continue"}
                </button>
              </form>
            </>
          )}

          {/* ── Step 2: First device ── */}
          {step === "device" && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Register your first device
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mb-6">
                Enter the serial number on the device label. You can skip this and add devices later.
              </p>
              <form onSubmit={handleRegisterDevice}>
                <label
                  htmlFor="serial"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  Serial Number <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  id="serial"
                  type="text"
                  autoFocus
                  value={serial}
                  onChange={(e) => { setSerial(e.target.value.toUpperCase()); setError(null); }}
                  placeholder="e.g. SN00123456"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700
                             bg-white dark:bg-gray-800 text-gray-900 dark:text-white
                             rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <div className="mt-4 flex gap-3">
                  <button
                    type="button"
                    onClick={() => setStep("billing")}  // skip device registration
                    disabled={loading}
                    className="flex-1 py-2 border border-gray-300 dark:border-gray-700
                               text-gray-700 dark:text-gray-300 rounded-lg text-sm
                               hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
                  >
                    Skip
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 py-2 bg-green-600 text-white rounded-lg text-sm font-medium
                               hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                    {loading ? "Registering…" : "Continue"}
                  </button>
                </div>
              </form>
            </>
          )}

          {/* ── Step 3: Billing ── */}
          {step === "billing" && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Choose your plan
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mb-6">
                Start with a 14-day free trial. Cancel any time.
              </p>

              <div className="space-y-4">
                {/* Starter plan */}
                <button
                  onClick={() => handleChoosePlan("starter")}
                  disabled={loading}
                  className="w-full text-left p-4 border border-gray-200 dark:border-gray-700
                             rounded-xl hover:border-green-500 dark:hover:border-green-500
                             transition-colors disabled:opacity-50 group"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-semibold text-gray-900 dark:text-white">Starter</p>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Up to 10 devices</p>
                    </div>
                    <p className="font-bold text-green-600">$49/mo</p>
                  </div>
                </button>

                {/* Professional plan */}
                <button
                  onClick={() => handleChoosePlan("professional")}
                  disabled={loading}
                  className="w-full text-left p-4 border-2 border-green-500 rounded-xl
                             hover:bg-green-50 dark:hover:bg-green-900/10
                             transition-colors disabled:opacity-50 relative"
                >
                  {/* Most popular badge */}
                  <span className="absolute -top-3 left-4 px-2 py-0.5 bg-green-600 text-white
                                   text-xs font-medium rounded-full">
                    Most popular
                  </span>
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-semibold text-gray-900 dark:text-white">Professional</p>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Up to 100 devices</p>
                    </div>
                    <p className="font-bold text-green-600">$199/mo</p>
                  </div>
                </button>

                {/* Skip to dashboard — they can pay later */}
                <button
                  onClick={() => navigate("/")}
                  disabled={loading}
                  className="w-full text-center text-sm text-gray-500 dark:text-gray-400
                             hover:text-gray-700 dark:hover:text-gray-300 py-2"
                >
                  Skip for now — I'll choose a plan later
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
