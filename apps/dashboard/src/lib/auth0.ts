type AuthorizationParams = Record<string, unknown> & {
  audience?: string;
  scope?: string;
};

type AppState = Record<string, unknown> & {
  returnTo?: string;
};

type Auth0Options = Record<string, unknown> & {
  authorizationParams?: AuthorizationParams;
  appState?: AppState;
};

declare global {
  interface Window {
    __getToken?: typeof getAccessTokenSilently;
  }
}

const AUTH_AUDIENCE = import.meta.env.VITE_AUTH0_AUDIENCE;
const AUTH_SCOPE =
  import.meta.env.VITE_AUTH0_SCOPE ?? "openid profile email offline_access";

let _getToken: ((options?: Auth0Options) => Promise<string>) | null = null;
let _loginWithRedirect: ((options?: Auth0Options) => Promise<void>) | null = null;
let authRecoveryStarted = false;

function withDefaultAuthParams(options: Auth0Options = {}): Auth0Options {
  return {
    ...options,
    authorizationParams: {
      ...options.authorizationParams,
      ...(AUTH_AUDIENCE ? { audience: AUTH_AUDIENCE } : {}),
      scope:
        typeof options.authorizationParams?.scope === "string"
          ? options.authorizationParams.scope
          : AUTH_SCOPE,
    },
  };
}

function withReturnTo(options: Auth0Options = {}): Auth0Options {
  const returnTo =
    options.appState?.returnTo ??
    `${window.location.pathname}${window.location.search}${window.location.hash}`;

  return {
    ...withDefaultAuthParams(options),
    appState: {
      ...options.appState,
      returnTo,
    },
  };
}

function shouldRecoverAuthSession(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes("missing refresh token") ||
    message.includes("missing_refresh_token") ||
    message.includes("login_required") ||
    message.includes("consent_required")
  );
}

function waitForRedirect(): Promise<never> {
  return new Promise<never>(() => undefined);
}

function startAuthRecovery(): Promise<never> {
  if (!_loginWithRedirect) {
    throw new Error("Auth0 login not initialized");
  }

  if (!authRecoveryStarted) {
    authRecoveryStarted = true;
    void _loginWithRedirect(withReturnTo()).catch(() => {
      authRecoveryStarted = false;
    });
  }

  return waitForRedirect();
}

export function setGetAccessTokenSilently(
  fn: (options?: Auth0Options) => Promise<string>
) {
  _getToken = fn;
}

export function setLoginWithRedirect(
  fn: (options?: Auth0Options) => Promise<void>
) {
  _loginWithRedirect = fn;
}

export async function getAccessTokenSilently(
  options?: Auth0Options
): Promise<string> {
  if (!_getToken) throw new Error("Auth0 not initialized");

  try {
    return await _getToken(withDefaultAuthParams(options));
  } catch (error) {
    if (shouldRecoverAuthSession(error)) {
      return startAuthRecovery();
    }
    throw error;
  }
}

export async function loginWithRedirect(options?: Auth0Options): Promise<void> {
  if (!_loginWithRedirect) throw new Error("Auth0 login not initialized");
  return _loginWithRedirect(withReturnTo(options));
}

window.__getToken = getAccessTokenSilently;
