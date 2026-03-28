import { createContext } from "react";

export interface TenantContextValue {
  activeTenantId: string | null;
  availableTenants: string[];
  setActiveTenant: (tenantId: string) => void;
  isLoading: boolean;
}

export const TenantContext = createContext<TenantContextValue | null>(null);
