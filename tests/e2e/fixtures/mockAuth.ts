import { Page } from "@playwright/test";

// ─── Fake JWT ─────────────────────────────────────────────────────────────────
// A base64url-encoded JWT with GrainGuard claims.
// No real signature needed — the dashboard just reads it from localStorage
// and the API calls are mocked by page.route(), so nothing validates it.

function b64(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

const CLIENT_ID = process.env.VITE_AUTH0_CLIENT_ID || "e2e-client-id";
const AUDIENCE = process.env.VITE_AUTH0_AUDIENCE || "https://api.grainguard.test";

const HEADER = b64({ alg: "RS256", typ: "JWT" });
const TOKEN_PAYLOAD = {
  sub:    "auth0|e2e-test-user",
  email:  "e2e@grainguard.com",
  name:   "E2E Test User",
  iss:    "https://e2e.auth0.local/",
  aud:    AUDIENCE,
  iat:    Math.floor(Date.now() / 1000),
  exp:    Math.floor(Date.now() / 1000) + 86400, // 24h
  "https://grainguard.com/tenant_id": "00000000-0000-0000-0000-000000000001",
  "https://grainguard.com/roles":     ["admin", "superadmin"],
  "https://grainguard/tenant_id": "00000000-0000-0000-0000-000000000001",
  "https://grainguard/roles":     ["admin", "superadmin"],
};
const PAYLOAD = b64(TOKEN_PAYLOAD);

export const FAKE_TOKEN = `${HEADER}.${PAYLOAD}.fake_signature`;

// ─── Auth0 localStorage cache key ────────────────────────────────────────────
// auth0-spa-js reads from this key to decide if the user is authenticated.

const AUTH0_CACHE_KEY = `@@auth0spajs@@::${CLIENT_ID}::${AUDIENCE}::openid profile email`;

const AUTH0_CACHE_VALUE = JSON.stringify({
  body: {
    access_token:  FAKE_TOKEN,
    id_token:      FAKE_TOKEN,
    scope:         "openid profile email",
    expires_in:    86400,
    token_type:    "Bearer",
    decodedToken: {
      encoded: { header: HEADER, payload: PAYLOAD, signature: "fake" },
      header:  { alg: "RS256", typ: "JWT" },
      user: {
        sub: TOKEN_PAYLOAD.sub,
        email: TOKEN_PAYLOAD.email,
        name: TOKEN_PAYLOAD.name,
        "https://grainguard.com/tenant_id": "00000000-0000-0000-0000-000000000001",
        "https://grainguard.com/roles": ["admin", "superadmin"],
        "https://grainguard/tenant_id": "00000000-0000-0000-0000-000000000001",
        "https://grainguard/roles": ["admin", "superadmin"],
      },
    },
    audience:  AUDIENCE,
    client_id: CLIENT_ID,
  },
  expiresAt: Math.floor(Date.now() / 1000) + 86400,
});

// ─── Mock API responses ───────────────────────────────────────────────────────

const MOCK_DEVICES = [
  {
    deviceId: "dev-1",
    serialNumber: "SN00100001",
    tenantId: "00000000-0000-0000-0000-000000000001",
    temperature: 24.5,
    humidity: 61,
    recordedAt: new Date().toISOString(),
  },
  {
    deviceId: "dev-2",
    serialNumber: "SN00100002",
    tenantId: "00000000-0000-0000-0000-000000000001",
    temperature: null,
    humidity: null,
    recordedAt: new Date().toISOString(),
  },
];

const MOCK_SUBSCRIPTION = {
  plan: "professional",
  subscription_status: "active",
  trial_ends_at: null,
  current_period_end: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
};

// ─── injectMockAuth ───────────────────────────────────────────────────────────
// Call this in beforeEach to set up a fully authenticated test environment.

export async function injectMockAuth(page: Page): Promise<void> {
  // Keep health requests happy for CSRF/bootstrap checks.
  await page.route("**/health", (route) =>
    route.fulfill({ status: 200, json: { ok: true } })
  );

  // 1. Intercept Auth0 JWKS — return empty keyset (we never validate sig in tests)
  await page.route("**/.well-known/jwks.json", (route) =>
    route.fulfill({ json: { keys: [] } })
  );

  // 2. Intercept Auth0 token endpoint — return fake token
  await page.route("**/oauth/token", (route) =>
    route.fulfill({
      json: {
        access_token:  FAKE_TOKEN,
        id_token:      FAKE_TOKEN,
        token_type:    "Bearer",
        expires_in:    86400,
        scope:         "openid profile email",
      },
    })
  );

  // 3. Intercept GraphQL (BFF) — return mock data
  await page.route("**/graphql", (route) => {
    const body = route.request().postDataJSON() as { query?: string } | null;
    const query = body?.query ?? "";

    if (query.includes("devices") || query.includes("Devices")) {
      return route.fulfill({
        json: {
          data: {
            devices: MOCK_DEVICES,
            deviceTelemetry: [],
          },
        },
      });
    }

    if (query.includes("me") || query.includes("tenant")) {
      return route.fulfill({
        json: {
          data: {
            me: {
              id:       "00000000-0000-0000-0000-000000000001",
              email:    "e2e@grainguard.com",
              tenantId: "00000000-0000-0000-0000-000000000001",
              plan:     "professional",
            },
          },
        },
      });
    }

    // Default — empty success
    return route.fulfill({ json: { data: {} } });
  });

  // 4. Intercept REST billing endpoint
  await page.route("**/billing/subscription", (route) =>
    route.fulfill({ json: MOCK_SUBSCRIPTION })
  );

  // 5. Intercept REST devices endpoint
  await page.route("**/devices**", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: MOCK_DEVICES });
    }
    return route.fulfill({
      json: {
        deviceId: "dev-new",
        serialNumber: "SNNEW001",
        tenantId: "00000000-0000-0000-0000-000000000001",
        temperature: null,
        humidity: null,
        recordedAt: new Date().toISOString(),
      },
    });
  });

  // 6. Inject Auth0 cache into localStorage before app loads
  await page.addInitScript(
    ({ key, value, token }) => {
      localStorage.setItem(key, value);
      localStorage.setItem("__e2e_access_token", token);
    },
    { key: AUTH0_CACHE_KEY, value: AUTH0_CACHE_VALUE, token: FAKE_TOKEN }
  );
}
