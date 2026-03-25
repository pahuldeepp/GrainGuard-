import { useState } from "react";
import { getAccessTokenSilently } from "../../../lib/auth0";

interface RegisterResult {
  deviceId: string;
  serialNumber: string;
  tenantId: string;
}

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "http://localhost:3000";

export function useRegisterDevice() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => setError(null);

  const register = async (serialNumber: string): Promise<RegisterResult> => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessTokenSilently();
      const res = await fetch(`${GATEWAY_URL}/devices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ serialNumber }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Registration failed (${res.status})`);
      }
      return await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return { register, loading, error, reset };
}
