import { getAccessTokenSilently } from "./auth0";

const GW = import.meta.env.VITE_GATEWAY_URL ?? "";
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
