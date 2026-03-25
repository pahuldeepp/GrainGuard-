import { test, expect } from "@playwright/test";

test.describe("Smoke tests", () => {
  test("landing page loads and shows GrainGuard branding", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/GrainGuard/i);
  });

  test("health endpoint returns ok", async ({ request }) => {
    const response = await request.get("http://localhost:8086/health");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  test("readiness endpoint returns dependency checks", async ({ request }) => {
    const response = await request.get("http://localhost:8086/health/ready");
    const body = await response.json();
    expect(body.checks).toBeDefined();
    expect(body.checks.postgres).toBeDefined();
    expect(body.checks.redis).toBeDefined();
  });

  test("billing endpoint requires auth", async ({ request }) => {
    const response = await request.get("http://localhost:8086/billing/subscription");
    expect(response.status()).toBe(401);
  });

  test("CORS headers are present", async ({ request }) => {
    const response = await request.get("http://localhost:8086/health", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(response.headers()["access-control-allow-origin"]).toBeTruthy();
  });
});
