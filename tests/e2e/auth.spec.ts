import { test, expect } from "@playwright/test";
import { injectMockAuth } from "./fixtures/mockAuth";

// ─── Unauthenticated tests ────────────────────────────────────────────────────
// No credentials needed — these just verify what anonymous users see.

test.describe("Auth wall", () => {
  test("unauthenticated user sees login prompt", async ({ page }) => {
    await page.goto("/");
    const loginBtn = page.getByRole("button", { name: /log in|sign in/i });
    await expect(loginBtn).toBeVisible({ timeout: 10_000 });
  });

  test("protected route redirects to login", async ({ page }) => {
    await page.goto("/billing");
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

// ─── Authenticated tests ──────────────────────────────────────────────────────
// Uses mock auth fixture — no real Auth0 credentials needed.

test.describe("Authenticated user", () => {
  test.beforeEach(async ({ page }) => {
    await injectMockAuth(page);
  });

  test("devices page loads after login", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });
  });

  test("billing page shows plan cards", async ({ page }) => {
    await page.goto("/billing");
    await expect(page.getByText("Starter")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Professional")).toBeVisible();
  });
});
