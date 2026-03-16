import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";

const TENANT_CLAIM = "https://grainguard/tenant_id";

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
  const { isAuthenticated, isLoading: authLoading, getAccessTokenSilently } = useAuth0();
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [availableTenants, setAvailableTenants] = useState<string[]>([]);

  useEffect(() => {
    if (!isAuthenticated) return;

    async function extractTenant() {
      try {
        const token = await getAccessTokenSilently();
        const payload = JSON.parse(atob(token.split(".")[1]));
        console.log("Access token payload:", payload);
        console.log("Tenant from access token:", payload[TENANT_CLAIM]);

        const tenantId = payload[TENANT_CLAIM] as string | undefined;
        if (tenantId) {
          setActiveTenantId(tenantId);
          setAvailableTenants([tenantId]);
        }
      } catch (err) {
        console.error("Failed to extract tenant from token:", err);
      }
    }

    extractTenant();
  }, [isAuthenticated, getAccessTokenSilently]);

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
