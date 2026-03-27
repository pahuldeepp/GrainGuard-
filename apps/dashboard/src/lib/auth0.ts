type TokenOptions = Record<string, unknown>;
type RedirectOptions = Record<string, unknown>;
type GetTokenFn = (options?: TokenOptions) => Promise<string>;
type LoginWithRedirectFn = (options?: RedirectOptions) => Promise<void>;

declare global {
  interface Window {
    __getToken?: typeof getAccessTokenSilently;
  }
}

let _getToken: GetTokenFn | null = null;
let _loginWithRedirect: LoginWithRedirectFn | null = null;

export function setGetAccessTokenSilently(fn: GetTokenFn) {
  _getToken = fn;
}

export function setLoginWithRedirect(fn: LoginWithRedirectFn) {
  _loginWithRedirect = fn;
}

export async function getAccessTokenSilently(options?: TokenOptions): Promise<string> {
  if (!_getToken) throw new Error("Auth0 not initialized");
  return _getToken(options);
}

export async function loginWithRedirect(options?: RedirectOptions): Promise<void> {
  if (!_loginWithRedirect) throw new Error("Auth0 login not initialized");
  return _loginWithRedirect(options);
}

if (import.meta.env.DEV) {
  window.__getToken = getAccessTokenSilently;
}
