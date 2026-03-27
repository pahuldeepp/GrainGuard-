import { createContext, useContext, useState, useEffect } from "react";
import type { ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";

// Auth0 Action injects claims under https://grainguard.com/ namespace
const TENANT_CLAIM = "https://grainguard.com/tenant_id";
const LEGACY_TENANT_CLAIM = "https://grainguard/tenant_id";

interface TenantContextValue {
  activeTenantId: string | null;
  availableTenants: string[];
  setActiveTenant: (tenantId: string) => void;
  isLoading: boolean;
}

const TenantContext = createContext<TenantContextValue | null>(null);

interface Props {
  children: ReactNode;
}

export function TenantProvider({ children }: Props) {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth0();
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [availableTenants, setAvailableTenants] = useState<string[]>([]);

  useEffect(() => {
    if (!isAuthenticated) {
      setActiveTenantId(null);
      setAvailableTenants([]);
      return;
    }

    const tenantId =
      (user?.[TENANT_CLAIM] as string | undefined) ??
      (user?.[LEGACY_TENANT_CLAIM] as string | undefined) ??
      null;

    if (tenantId) {
      setActiveTenantId(tenantId);
      setAvailableTenants([tenantId]);
      return;
    }

    setActiveTenantId(null);
    setAvailableTenants([]);
  }, [isAuthenticated, user]);

  const setActiveTenant = (tenantId: string) => {
    setActiveTenantId(tenantId);
  };

  return (
    <TenantContext.Provider
      value={{
        activeTenantId,
        availableTenants,
        setActiveTenant,
        isLoading: authLoading,
      }}
    >
      {children}
    </TenantContext.Provider>
  );
}

export function useTenantContext() {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error("useTenantContext must be used within TenantProvider");
  return ctx;
}
