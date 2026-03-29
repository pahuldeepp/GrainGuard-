import { getAccessTokenSilently } from "./auth0";

const GW = import.meta.env.VITE_GATEWAY_URL ?? "";
const INSECURE_AUTH_ENABLED = import.meta.env.VITE_ALLOW_INSECURE_AUTH === "true";
const INSECURE_TENANT_ID = import.meta.env.VITE_INSECURE_TENANT_ID ?? "";
const CSRF_COOKIE  = "_csrf";
const CSRF_HEADER  = "x-csrf-token";
const MUTATING     = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getCsrfToken(): string {
  return (
    document.cookie
      .split("; ")
      .find((row) => row.startsWith(`${CSRF_COOKIE}=`))
      ?.split("=")
      .slice(1)
      .join("=") ?? ""
  );
}

async function refreshCsrf(): Promise<void> {
  await fetch(`${GW}/health`, { credentials: "include" });
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const token      = await getAccessTokenSilently();
  const method     = (options.method ?? "GET").toUpperCase();
  const isMutating = MUTATING.has(method);

  // Ensure we have a CSRF cookie before any mutating request
  if (isMutating && !getCsrfToken()) {
    await refreshCsrf();
  }

  function buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${token}`,
      ...(isMutating ? { [CSRF_HEADER]: getCsrfToken() } : {}),
      ...(INSECURE_AUTH_ENABLED && INSECURE_TENANT_ID
        ? { "x-tenant-id": INSECURE_TENANT_ID }
        : {}),
      ...(options.headers as Record<string, string>),
    };
  }

  let res = await fetch(`${GW}${path}`, {
    ...options,
    credentials: "include",
    headers: buildHeaders(),
  });

  // Auto-retry once on expired / missing CSRF token
  if (res.status === 403 && isMutating) {
    const body = await res.json().catch(() => ({}));
    if (typeof body?.error === "string" && body.error.startsWith("csrf_token")) {
      await refreshCsrf();
      res = await fetch(`${GW}${path}`, {
        ...options,
        credentials: "include",
        headers: buildHeaders(),
      });
    } else {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
