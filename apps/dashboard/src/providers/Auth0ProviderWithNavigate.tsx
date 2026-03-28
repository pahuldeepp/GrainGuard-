import type { ReactNode } from "react";
import { Auth0Provider } from "@auth0/auth0-react";
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

export function Auth0ProviderWithNavigate({ children }: Props) {
  const navigate = useNavigate();

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
