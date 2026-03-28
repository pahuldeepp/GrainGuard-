import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { getAccessTokenSilently, loginWithRedirect } from "../../lib/auth0";
import { BrandLogo } from "../../shared/components/BrandLogo";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "http://localhost:3000";

type Stage = "loading" | "unauthenticated" | "ready" | "accepting" | "success" | "expired" | "error";

export function InviteAcceptPage() {
  const [searchParams]             = useSearchParams();
  const token                      = searchParams.get("token") ?? "";
  const { isAuthenticated, isLoading } = useAuth0();

  const [stage,      setStage]      = useState<Stage>(() => (token ? "loading" : "error"));
  const [errorMsg,   setErrorMsg]   = useState<string>(() =>
    token ? "" : "No invite token in the URL."
  );
  const [tenantName, setTenantName] = useState<string>("");
  const [role,       setRole]       = useState<string>("");

  // Step 1: Fetch invite info (public endpoint — no auth needed)
  useEffect(() => {
    if (!token) return;
    if (isLoading) return; // Wait for Auth0 to resolve

    (async () => {
      try {
        const res  = await fetch(
          `${GATEWAY_URL}/team/invite/info?token=${encodeURIComponent(token)}`
        );
        const body = await res.json();
        if (!res.ok) {
          if (res.status === 410) {
            setStage("expired");
          } else {
            setStage("error");
            setErrorMsg(body.error ?? "Invite not found.");
          }
          return;
        }
        setTenantName(body.tenantName ?? "");
        setRole(body.role ?? "member");
        setStage(isAuthenticated ? "ready" : "unauthenticated");
      } catch {
        setStage("error");
        setErrorMsg("Could not reach server. Please try again.");
      }
    })();
  }, [token, isLoading, isAuthenticated]);

  // Step 2: Accept once the user is authenticated
  async function handleAccept() {
    setStage("accepting");
    try {
      const jwt = await getAccessTokenSilently();
      const res = await fetch(`${GATEWAY_URL}/team/invite/accept`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${jwt}`,
        },
        body: JSON.stringify({ token }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (res.status === 410 || body.error?.includes("expired")) {
          setStage("expired");
        } else if (body.error === "already_a_member") {
          setStage("success"); // Idempotent — already a member is fine
        } else {
          setStage("error");
          setErrorMsg(body.error ?? "Could not accept invite.");
        }
        return;
      }
      setStage("success");
    } catch {
      setStage("error");
      setErrorMsg("Network error. Please try again.");
    }
  }

  function handleLogin() {
    loginWithRedirect({
      appState: {
        returnTo: `/invite/accept?token=${encodeURIComponent(token)}`,
      },
    });
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 p-8 shadow-sm text-center">

        {/* Brand mark */}
        <BrandLogo
          showWordmark={false}
          className="flex justify-center mb-6"
          markClassName="h-12 w-12"
        />

        {(stage === "loading" || isLoading) && (
          <p className="text-gray-500 dark:text-gray-400">Checking invite…</p>
        )}

        {/* User is not logged in — prompt them to sign in first */}
        {stage === "unauthenticated" && (
          <>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              You've been invited
            </h1>
            <p className="text-gray-600 dark:text-gray-300 mb-1">
              Join <strong>{tenantName || "a GrainGuard workspace"}</strong>
              {role ? ` as ${role}` : ""}.
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Sign in to accept the invitation.
            </p>
            <button
              onClick={handleLogin}
              className="w-full py-2.5 px-4 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
            >
              Sign in to Accept
            </button>
          </>
        )}

        {/* Logged in, ready to accept */}
        {stage === "ready" && (
          <>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              You've been invited
            </h1>
            <p className="text-gray-600 dark:text-gray-300 mb-6">
              Join <strong>{tenantName || "a GrainGuard workspace"}</strong>
              {role ? ` as ${role}` : ""}.
            </p>
            <button
              onClick={handleAccept}
              className="w-full py-2.5 px-4 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
            >
              Accept Invitation
            </button>
          </>
        )}

        {stage === "accepting" && (
          <p className="text-gray-500 dark:text-gray-400">Accepting invite…</p>
        )}

        {stage === "success" && (
          <>
            <div className="text-green-600 text-4xl mb-4">✓</div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              You're in!
            </h1>
            <p className="text-gray-600 dark:text-gray-300 mb-6">
              You now have access to <strong>{tenantName || "the workspace"}</strong>.
            </p>
            <Link
              to="/"
              className="inline-block py-2.5 px-6 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
            >
              Go to Dashboard
            </Link>
          </>
        )}

        {stage === "expired" && (
          <>
            <div className="text-orange-500 text-4xl mb-4">⏰</div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              Invite expired
            </h1>
            <p className="text-gray-600 dark:text-gray-300 mb-6">
              This invitation has expired or already been used.
              Ask your admin to send a new one.
            </p>
            <Link
              to="/"
              className="inline-block py-2.5 px-6 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg font-medium transition-colors hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Go to Dashboard
            </Link>
          </>
        )}

        {stage === "error" && (
          <>
            <div className="text-red-500 text-4xl mb-4">✕</div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              Something went wrong
            </h1>
            <p className="text-gray-600 dark:text-gray-300 mb-6">
              {errorMsg || "Could not process the invitation."}
            </p>
            <Link
              to="/"
              className="inline-block py-2.5 px-6 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg font-medium transition-colors hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Go to Dashboard
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
