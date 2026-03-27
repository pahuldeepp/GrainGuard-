import { test, expect } from "@playwright/test";
import { injectMockAuth } from "./fixtures/mockAuth";

// Uses mock auth — no real Auth0 credentials needed.

test.describe("Billing page", () => {
  test.beforeEach(async ({ page }) => {
    await injectMockAuth(page);
    await page.goto("/billing");
  });

  test("shows three plan cards", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Starter" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Professional" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Enterprise" })).toBeVisible();
  });

  test("shows plan prices", async ({ page }) => {
    await expect(page.getByText("$29/mo")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("$99/mo")).toBeVisible();
  });

  test("Enterprise card shows Contact Sales button", async ({ page }) => {
    const contactButton = page.getByRole("button", { name: "Contact Sales" });
    await expect(contactButton).toBeVisible({ timeout: 10_000 });
    await expect(contactButton).toBeEnabled();
  });

  test("Upgrade button for Starter exists and is clickable", async ({ page }) => {
    const upgradeBtn = page.getByRole("button", { name: "Upgrade" }).first();
    await expect(upgradeBtn).toBeVisible({ timeout: 10_000 });
    await expect(upgradeBtn).toBeEnabled();
  });
});
