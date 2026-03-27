import { useState } from "react";
import { apiFetch } from "../../../lib/apiFetch";

interface RegisterResult {
  deviceId: string;
  serialNumber: string;
  tenantId: string;
}

export function useRegisterDevice() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => setError(null);

  const register = async (serialNumber: string): Promise<RegisterResult> => {
    setLoading(true);
    setError(null);
    try {
      return await apiFetch("/devices", {
        method: "POST",
        body: JSON.stringify({ serialNumber }),
      }) as RegisterResult;
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
