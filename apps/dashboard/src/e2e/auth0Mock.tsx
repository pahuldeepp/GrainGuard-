import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type AuthorizationParams = {
  audience?: string;
  redirect_uri?: string;
  screen_hint?: string;
};

type LoginOptions = {
  authorizationParams?: AuthorizationParams;
  returnTo?: string;
};

type LogoutOptions = {
  logoutParams?: {
    returnTo?: string;
  };
};

type MockUser = Record<string, unknown> & {
  sub?: string;
  email?: string;
  name?: string;
};

type RedirectAppState = {
  returnTo?: string;
};

type Auth0ContextValue = {
  user?: MockUser;
  isAuthenticated: boolean;
  isLoading: boolean;
  error?: Error;
  loginWithRedirect: (options?: LoginOptions) => Promise<void>;
  logout: (options?: LogoutOptions) => void;
  getAccessTokenSilently: (options?: { authorizationParams?: AuthorizationParams }) => Promise<string>;
};

const Auth0Context = createContext<Auth0ContextValue | null>(null);

type E2EWindow = Window & {
  __e2e_access_token__?: string;
};

function readToken(): string | null {
  return (window as E2EWindow).__e2e_access_token__ ?? null;
}

function writeToken(token: string | null): void {
  if (token) {
    (window as E2EWindow).__e2e_access_token__ = token;
    return;
  }

  delete (window as E2EWindow).__e2e_access_token__;
}

function parseTokenPayload(token: string): MockUser | undefined {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(normalized);
    return JSON.parse(decoded) as MockUser;
  } catch {
    return undefined;
  }
}

function toSameOriginPath(value?: string): string {
  if (!value) return "/";

  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return value.startsWith("/") ? value : "/";
  }
}

function navigateTo(path: string, mode: "push" | "replace" = "push"): void {
  const method = mode === "replace" ? "replaceState" : "pushState";
  window.history[method](null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Auth0Provider({
  children,
  onRedirectCallback,
}: {
  children: ReactNode;
  domain?: string;
  clientId?: string;
  authorizationParams?: AuthorizationParams;
  cacheLocation?: string;
  onRedirectCallback?: (appState?: RedirectAppState) => void;
}) {
  const [token, setToken] = useState<string | null>(() => readToken());

  const value = useMemo<Auth0ContextValue>(() => {
    const user = token ? parseTokenPayload(token) : undefined;

    return {
      user,
      isAuthenticated: Boolean(token),
      isLoading: false,
      error: undefined,
      async loginWithRedirect(options) {
        const returnTo = toSameOriginPath(
          options?.returnTo ??
          options?.authorizationParams?.redirect_uri ??
          "/"
        );
        navigateTo(returnTo);
        onRedirectCallback?.({ returnTo });
      },
      logout(options) {
        writeToken(null);
        setToken(null);
        const returnTo = toSameOriginPath(options?.logoutParams?.returnTo ?? "/");
        navigateTo(returnTo, "replace");
        onRedirectCallback?.({ returnTo });
      },
      async getAccessTokenSilently() {
        const nextToken = token ?? readToken();
        if (!nextToken) throw new Error("Not authenticated");
        return nextToken;
      },
    };
  }, [onRedirectCallback, token]);

  return <Auth0Context.Provider value={value}>{children}</Auth0Context.Provider>;
}

export function useAuth0(): Auth0ContextValue {
  const value = useContext(Auth0Context);
  if (!value) {
    throw new Error("useAuth0 must be used within Auth0Provider");
  }
  return value;
}
