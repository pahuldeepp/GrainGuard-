import { test, expect } from "@playwright/test";
import { injectMockAuth } from "./fixtures/mockAuth";

// Uses mock auth — no real Auth0 credentials needed.

test.describe("Billing page", () => {
  test.beforeEach(async ({ page }) => {
    await injectMockAuth(page);
    await page.goto("/billing");
  });

  test("shows three plan cards", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Starter", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Professional", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Enterprise", exact: true })).toBeVisible();
  });

  test("shows plan prices", async ({ page }) => {
    const recurringPrices = page.getByText(/\$\d+\/mo/);
    await expect(recurringPrices.first()).toBeVisible({ timeout: 10_000 });
    await expect(recurringPrices).toHaveCount(2);
  });

  test("Enterprise card shows Contact Sales link", async ({ page }) => {
    const contactLink = page.getByRole("link", { name: "Contact Sales" });
    await expect(contactLink).toBeVisible({ timeout: 10_000 });
    await expect(contactLink).toHaveAttribute("href", /mailto:sales@/);
  });

  test("Upgrade button for Starter exists and is clickable", async ({ page }) => {
    const upgradeBtn = page.getByRole("button", { name: "Upgrade" }).first();
    await expect(upgradeBtn).toBeVisible({ timeout: 10_000 });
    await expect(upgradeBtn).toBeEnabled();
  });
});
