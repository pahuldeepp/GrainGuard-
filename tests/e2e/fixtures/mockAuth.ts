import { Page } from "@playwright/test";

// ─── Fake JWT ─────────────────────────────────────────────────────────────────
// A base64url-encoded JWT with GrainGuard claims.
// No real signature needed — the dashboard just reads it from localStorage
// and the API calls are mocked by page.route(), so nothing validates it.

function b64(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

const HEADER  = b64({ alg: "RS256", typ: "JWT" });
const PAYLOAD = b64({
  sub:    "auth0|e2e-test-user",
  email:  "e2e@grainguard.com",
  name:   "E2E Test User",
  iss:    "https://dev-dz6bl3nngdeib7ro.us.auth0.com/",
  aud:    "https://api.grainguard.com",
  iat:    Math.floor(Date.now() / 1000),
  exp:    Math.floor(Date.now() / 1000) + 86400, // 24h
  "https://grainguard.com/tenant_id": "00000000-0000-0000-0000-000000000001",
  "https://grainguard.com/roles":     ["admin"],
  "https://grainguard/tenant_id": "00000000-0000-0000-0000-000000000001",
  "https://grainguard/roles":     ["admin"],
});

export const FAKE_TOKEN = `${HEADER}.${PAYLOAD}.fake_signature`;

// ─── Auth0 localStorage cache key ────────────────────────────────────────────
// auth0-spa-js reads from this key to decide if the user is authenticated.

const CLIENT_ID = process.env.VITE_AUTH0_CLIENT_ID || "6DwwDrUpsC4LckBieVQdlGYtguTPnYys";
const AUDIENCE  = process.env.VITE_AUTH0_AUDIENCE  || "https://api.grainguard.com";
const SCOPE = "openid profile email offline_access";
const MOCK_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const AUTH0_CACHE_KEY = `@@auth0spajs@@::${CLIENT_ID}::${AUDIENCE}::${SCOPE}`;

const AUTH0_CACHE_VALUE = JSON.stringify({
  body: {
    access_token:  FAKE_TOKEN,
    id_token:      FAKE_TOKEN,
    scope:         SCOPE,
    expires_in:    86400,
    token_type:    "Bearer",
    decodedToken: {
      encoded: { header: HEADER, payload: PAYLOAD, signature: "fake" },
      header:  { alg: "RS256", typ: "JWT" },
      user: {
        sub:   "auth0|e2e-test-user",
        email: "e2e@grainguard.com",
        name:  "E2E Test User",
        "https://grainguard.com/tenant_id": MOCK_TENANT_ID,
        "https://grainguard/tenant_id": MOCK_TENANT_ID,
        "https://grainguard.com/roles": ["admin"],
        "https://grainguard/roles": ["admin"],
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
    deviceId: "00000000-0000-0000-0000-000000000001",
    tenantId: MOCK_TENANT_ID,
    serialNumber: "SN00100001",
    temperature: 21.5,
    humidity: 48.2,
    recordedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  },
  {
    deviceId: "00000000-0000-0000-0000-000000000002",
    tenantId: MOCK_TENANT_ID,
    serialNumber: "SN00100002",
    temperature: null,
    humidity: null,
    recordedAt: null,
    createdAt: new Date().toISOString(),
  },
];

const MOCK_SUBSCRIPTION = {
  plan: "professional",
  status: "active",
  trialEndsAt: null,
  currentPeriodEnd: Math.floor((Date.now() + 30 * 86400 * 1000) / 1000),
  cancelAtPeriodEnd: false,
  paymentFailed: false,
};

const MOCK_DEVICES_CONNECTION = {
  edges: MOCK_DEVICES.map((device) => ({
    cursor: device.deviceId,
    node: device,
  })),
  pageInfo: {
    endCursor: MOCK_DEVICES.at(-1)?.deviceId ?? null,
    hasNextPage: false,
  },
  totalCount: MOCK_DEVICES.length,
};

// ─── injectMockAuth ───────────────────────────────────────────────────────────
// Call this in beforeEach to set up a fully authenticated test environment.

export async function injectMockAuth(page: Page): Promise<void> {
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

    if (query.includes("__typename")) {
      return route.fulfill({ json: { data: { __typename: "Query" } } });
    }

    if (query.includes("devicesConnection")) {
      return route.fulfill({
        json: {
          data: {
            devicesConnection: MOCK_DEVICES_CONNECTION,
          },
        },
      });
    }

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

    if (query.includes("deviceTelemetryHistory")) {
      return route.fulfill({
        json: {
          data: {
            deviceTelemetryHistory: [],
          },
        },
      });
    }

    if (query.includes("deviceTelemetry")) {
      return route.fulfill({
        json: {
          data: {
            deviceTelemetry: null,
          },
        },
      });
    }

    if (query.includes("me") || query.includes("tenant")) {
      return route.fulfill({
        json: {
          data: {
            me: {
              id:       MOCK_TENANT_ID,
              email:    "e2e@grainguard.com",
              tenantId: MOCK_TENANT_ID,
              plan:     "professional",
            },
          },
        },
      });
    }

    return route.fulfill({
      status: 500,
      json: {
        errors: [
          {
            message: `Unhandled GraphQL operation in mockAuth: ${query.slice(0, 120) || "<empty>"}`,
          },
        ],
      },
    });
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
        deviceId: "00000000-0000-0000-0000-000000000099",
        tenantId: MOCK_TENANT_ID,
        serialNumber: "SNNEW001",
      },
    });
  });

  // 6. Inject Auth0 cache into localStorage before app loads
  await page.addInitScript(
    ({ clientId, key, value, token }) => {
      localStorage.setItem(key, value);
      localStorage.setItem("auth0.is.authenticated", "true");
      document.cookie = `auth0.is.authenticated=true; path=/`;
      document.cookie = `auth0.${clientId}.is.authenticated=true; path=/`;
      localStorage.setItem("__e2e_access_token", token);
    },
    { clientId: CLIENT_ID, key: AUTH0_CACHE_KEY, value: AUTH0_CACHE_VALUE, token: FAKE_TOKEN }
  );
}
