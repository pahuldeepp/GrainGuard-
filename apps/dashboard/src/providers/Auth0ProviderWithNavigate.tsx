import type { ReactNode } from "react";
import { Auth0Context, Auth0Provider, initialContext } from "@auth0/auth0-react";
import { useNavigate } from "react-router-dom";

const domain = import.meta.env.VITE_AUTH0_DOMAIN;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;
const audience = import.meta.env.VITE_AUTH0_AUDIENCE;
const useRefreshTokens = import.meta.env.VITE_AUTH0_USE_REFRESH_TOKENS !== "false";
const useRefreshTokensFallback =
  import.meta.env.VITE_AUTH0_USE_REFRESH_TOKENS_FALLBACK === "true";
const scope =
  import.meta.env.VITE_AUTH0_SCOPE ?? "openid profile email offline_access";

interface Props {
  children: ReactNode;
}

const E2E_TOKEN_KEY = "__e2e_access_token";
const E2E_TENANT_ID = "00000000-0000-0000-0000-000000000001";

function getE2EContextValue() {
  if (typeof window === "undefined") return null;

  const token = window.localStorage.getItem(E2E_TOKEN_KEY);
  if (!token) return null;

  const user = {
    sub: "auth0|e2e-test-user",
    email: "e2e@grainguard.com",
    name: "E2E Test User",
    "https://grainguard.com/tenant_id": E2E_TENANT_ID,
    "https://grainguard/tenant_id": E2E_TENANT_ID,
    "https://grainguard.com/roles": ["admin"],
    "https://grainguard/roles": ["admin"],
  };

  return {
    ...initialContext,
    isAuthenticated: true,
    isLoading: false,
    user,
    getAccessTokenSilently: async () => token,
    getAccessTokenWithPopup: async () => token,
    getIdTokenClaims: async () => undefined,
    loginWithRedirect: async () => undefined,
    loginWithPopup: async () => undefined,
    logout: async () => {
      window.localStorage.removeItem(E2E_TOKEN_KEY);
      window.location.assign("/");
    },
    handleRedirectCallback: async () => ({ appState: {} }),
  };
}

export function Auth0ProviderWithNavigate({ children }: Props) {
  const navigate = useNavigate();
  const e2eContextValue = getE2EContextValue();

  if (e2eContextValue) {
    return (
      <Auth0Context.Provider value={e2eContextValue as unknown as typeof initialContext}>
        {children}
      </Auth0Context.Provider>
    );
  }

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience,
        scope,
      }}
      cacheLocation="localstorage"
      useRefreshTokens={useRefreshTokens}
      useRefreshTokensFallback={useRefreshTokensFallback}
      onRedirectCallback={(appState) => {
        navigate(appState?.returnTo ?? "/", { replace: true });
      }}
    >
      {children}
    </Auth0Provider>
  );
}
