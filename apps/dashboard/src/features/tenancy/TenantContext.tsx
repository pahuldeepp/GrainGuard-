import { useMemo } from "react";
import type { ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { TenantContext } from "./context";

// Auth0 Action injects claims under https://grainguard.com/ namespace
const TENANT_CLAIM = "https://grainguard.com/tenant_id";
const LEGACY_TENANT_CLAIM = "https://grainguard/tenant_id";

interface Props {
  children: ReactNode;
}

export function TenantProvider({ children }: Props) {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth0();
  const activeTenantId = isAuthenticated
    ? ((user?.[TENANT_CLAIM] as string | undefined) ??
      (user?.[LEGACY_TENANT_CLAIM] as string | undefined) ??
      null)
    : null;
  const value = useMemo(
    () => ({
      activeTenantId,
      availableTenants: activeTenantId ? [activeTenantId] : [],
      setActiveTenant: () => undefined,
      isLoading: authLoading,
    }),
    [activeTenantId, authLoading],
  );

  return (
    <TenantContext.Provider value={value}>
      {children}
    </TenantContext.Provider>
  );
}
