import { test, expect } from "@playwright/test";

// These tests verify the authentication wall.
// They do NOT use a real Auth0 login — they check what unauthenticated users see.

test.describe("Auth wall", () => {
  test("unauthenticated user sees login prompt", async ({ page }) => {
    await page.goto("/");

    // The ProtectedRoute renders Auth0's login button when not authenticated
    // Auth0 SDK renders either a spinner or a login button depending on loading state
    const loginBtn = page.getByRole("button", { name: /log in|sign in/i });
    await expect(loginBtn).toBeVisible({ timeout: 10_000 });
  });

  test("protected route redirects to login", async ({ page }) => {
    await page.goto("/billing");
    // Should still show login button — not expose billing page
    const loginBtn = page.getByRole("button", { name: /log in|sign in/i });
    await expect(loginBtn).toBeVisible({ timeout: 10_000 });
  });

  test("page title is GrainGuard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/GrainGuard/i);
  });

  test("nav shows GrainGuard brand", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("GrainGuard").first()).toBeVisible();
  });
});

// ── Authenticated tests ────────────────────────────────────────────────────────
// These use the Auth0 Resource Owner Password Grant flow for test users.
// Requires: E2E_AUTH0_DOMAIN, E2E_AUTH0_CLIENT_ID, E2E_TEST_USERNAME, E2E_TEST_PASSWORD
// The test account must be set up in Auth0 with the correct tenant claim.

test.describe("Authenticated user", () => {
  // Auth fixture — gets a token before each test and injects it into localStorage
  // so the React app picks it up without going through the Auth0 redirect flow.
  test.beforeEach(async ({ page }) => {
    const domain     = process.env.E2E_AUTH0_DOMAIN;
    const clientId   = process.env.E2E_AUTH0_CLIENT_ID;
    const username   = process.env.E2E_TEST_USERNAME;
    const password   = process.env.E2E_TEST_PASSWORD;
    const audience   = process.env.E2E_AUTH0_AUDIENCE;

    if (!domain || !clientId || !username || !password) {
      test.skip(); // skip if env vars not provided
      return;
    }

    // Resource Owner Password Grant — only available for testing
    const tokenRes = await page.request.post(`https://${domain}/oauth/token`, {
      data: {
        grant_type:    "password",
        client_id:     clientId,
        username,
        password,
        audience,
        scope:         "openid profile email",
      },
    });

    const { access_token } = await tokenRes.json();

    // Inject token into the page before navigating
    await page.goto("/");
    await page.evaluate((token) => {
      // auth0-spa-js stores the token in a specific localStorage key format.
      // We also store it under our module-level key used by auth0.ts.
      localStorage.setItem("__e2e_access_token", token);
    }, access_token);
  });

  test("devices page loads after login", async ({ page }) => {
    if (!process.env.E2E_TEST_USERNAME) { test.skip(); return; }
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });
  });

  test("billing page shows plan cards", async ({ page }) => {
    if (!process.env.E2E_TEST_USERNAME) { test.skip(); return; }
    await page.goto("/billing");
    await expect(page.getByText("Starter")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Professional")).toBeVisible();
  });
});
