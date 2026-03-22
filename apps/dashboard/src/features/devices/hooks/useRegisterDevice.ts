import { useState } from "react";

// Shape of the response returned by POST /devices
interface RegisterDeviceResult {
  deviceId: string;
  serialNumber: string;
  status: string;
}

// Shape returned by this hook — controls are passed to the modal
export interface UseRegisterDeviceReturn {
  loading: boolean;
  error: string | null;
  register: (serialNumber: string) => Promise<RegisterDeviceResult | null>;
}

// Base URL for the gateway — Vite proxies /api to localhost:3000 in dev
const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? "";

export function useRegisterDevice(): UseRegisterDeviceReturn {
  const [loading, setLoading] = useState(false);  // true while the POST is in-flight
  const [error, setError]   = useState<string | null>(null); // last error message or null

  async function register(serialNumber: string): Promise<RegisterDeviceResult | null> {
    setLoading(true);  // show spinner in the modal button
    setError(null);    // clear any previous error message

    try {
      // POST /devices — authMiddleware on the gateway will read the JWT from
      // the Authorization header added by apollo.ts (same interceptor as GraphQL)
      const res = await fetch(`${GATEWAY}/devices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // getAccessTokenSilently result is stored in module-level variable by auth0.ts
          Authorization: `Bearer ${await getToken()}`,
        },
        body: JSON.stringify({ serialNumber }),
      });

      if (!res.ok) {
        // Gateway returns { error: "..." } JSON on failure
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      return (await res.json()) as RegisterDeviceResult;
    } catch (err) {
      // Surface the error so the modal can display it under the input
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      return null;          // caller checks for null to know it failed
    } finally {
      setLoading(false);    // always hide the spinner when done
    }
  }

  return { loading, error, register };
}

// ── Token helper ──────────────────────────────────────────────────────────────
// We need a token outside React lifecycle (inside a plain async function).
// auth0.ts stores the getAccessTokenSilently reference at module level so we
// can call it here without threading it through props.
async function getToken(): Promise<string> {
  const { getAccessTokenSilently } = await import("../../../lib/auth0");
  return getAccessTokenSilently();
}
