// review-sweep
let _getToken: ((options?: any) => Promise<string>) | null = null;

export function setGetAccessTokenSilently(fn: (options?: any) => Promise<string>) {
  _getToken = fn;
}

export async function getAccessTokenSilently(options?: any): Promise<string> {
  if (!_getToken) throw new Error("Auth0 not initialized");
  return _getToken(options);
}
(window as any).__getToken = getAccessTokenSilently;