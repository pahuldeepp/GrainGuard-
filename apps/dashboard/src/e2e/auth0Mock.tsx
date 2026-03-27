import {
  createContext,
  useContext,
  useEffect,
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

type Auth0ContextValue = {
  user?: MockUser;
  isAuthenticated: boolean;
  isLoading: boolean;
  error?: Error;
  loginWithRedirect: (options?: LoginOptions) => Promise<void>;
  logout: (options?: LogoutOptions) => void;
  getAccessTokenSilently: (options?: { authorizationParams?: AuthorizationParams }) => Promise<string>;
};

const TOKEN_KEY = "__e2e_access_token";

const Auth0Context = createContext<Auth0ContextValue | null>(null);

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

export function Auth0Provider({
  children,
}: {
  children: ReactNode;
  domain?: string;
  clientId?: string;
  authorizationParams?: AuthorizationParams;
  cacheLocation?: string;
  onRedirectCallback?: (appState?: { returnTo?: string }) => void;
}) {
  const [token, setToken] = useState<string | null>(() =>
    window.localStorage.getItem(TOKEN_KEY)
  );

  useEffect(() => {
    const onStorage = () => setToken(window.localStorage.getItem(TOKEN_KEY));
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<Auth0ContextValue>(() => {
    const user = token ? parseTokenPayload(token) : undefined;

    return {
      user,
      isAuthenticated: Boolean(token),
      isLoading: false,
      error: undefined,
      async loginWithRedirect(options) {
        const nextPath =
          options?.returnTo ??
          options?.authorizationParams?.redirect_uri ??
          "/";
        window.location.assign(nextPath);
      },
      logout(options) {
        window.localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        const returnTo = options?.logoutParams?.returnTo ?? "/";
        window.location.assign(returnTo);
      },
      async getAccessTokenSilently() {
        const nextToken = token ?? window.localStorage.getItem(TOKEN_KEY);
        if (!nextToken) throw new Error("Not authenticated");
        return nextToken;
      },
    };
  }, [token]);

  return <Auth0Context.Provider value={value}>{children}</Auth0Context.Provider>;
}

export function useAuth0(): Auth0ContextValue {
  const value = useContext(Auth0Context);
  if (!value) {
    throw new Error("useAuth0 must be used within Auth0Provider");
  }
  return value;
}
