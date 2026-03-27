let _getToken: ((options?: any) => Promise<string>) | null = null;
let _loginWithRedirect: ((options?: any) => Promise<void>) | null = null;

export function setGetAccessTokenSilently(fn: (options?: any) => Promise<string>) {
  _getToken = fn;
}

export function setLoginWithRedirect(fn: (options?: any) => Promise<void>) {
  _loginWithRedirect = fn;
}

export async function getAccessTokenSilently(options?: any): Promise<string> {
  if (!_getToken) throw new Error("Auth0 not initialized");
  return _getToken(options);
}

export async function loginWithRedirect(options?: any): Promise<void> {
  if (!_loginWithRedirect) throw new Error("Auth0 login not initialized");
  return _loginWithRedirect(options);
}

(window as any).__getToken = getAccessTokenSilently;
