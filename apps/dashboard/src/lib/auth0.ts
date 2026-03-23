let _getToken: ((options?: any) => Promise<string>) | null = null;
let _loginWithRedirect: ((options?: any) => Promise<void>) | null = null;

export function setGetAccessTokenSilently(fn: (options?: any) => Promise<string>) {
  _getToken = fn;
}

/**
 * Register the Auth0 loginWithRedirect function so that
 * getAccessTokenSilently() can trigger re-login when the
 * refresh token has expired or been revoked.
 */
export function setLoginWithRedirect(fn: (options?: any) => Promise<void>) {
  _loginWithRedirect = fn;
}

/**
 * Get a valid access token.
 * Automatically redirects to Auth0 login when the refresh token has
 * expired (login_required / invalid_grant / consent_required errors)
 * instead of silently breaking.
 */
export async function getAccessTokenSilently(options?: any): Promise<string> {
  if (!_getToken) throw new Error("Auth0 not initialized");

  try {
    return await _getToken(options);
  } catch (err: any) {
    const code: string = err?.error ?? err?.code ?? "";
    const msg: string  = err?.message ?? "";

    const isSessionExpired =
      code === "login_required" ||
      code === "invalid_grant" ||
      code === "consent_required" ||
      msg.includes("Missing Refresh Token") ||
      msg.includes("expired");

    if (isSessionExpired) {
      console.warn("[auth] Session expired — redirecting to login");
      if (_loginWithRedirect) {
        // Preserve the current page so Auth0 returns here after login
        await _loginWithRedirect({
          appState: { returnTo: window.location.pathname + window.location.search },
        });
      } else {
        // Fallback: hard reload to root triggers ProtectedRoute → Auth0 redirect
        window.location.replace("/");
      }
    }

    throw err;
  }
}

// ⚠️  window.__getToken intentionally removed — it exposed the token
// getter as a global in dev builds, allowing any script on the page to
// silently acquire bearer tokens.  Use getAccessTokenSilently() directly.
