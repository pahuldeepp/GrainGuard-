import { test, expect } from "@playwright/test";

test.describe("Billing page", () => {
  test.beforeEach(async ({ page }) => {
    if (!process.env.E2E_TEST_USERNAME) { test.skip(); return; }
    await page.goto("/billing");
  });

  test("shows three plan cards", async ({ page }) => {
    if (!process.env.E2E_TEST_USERNAME) { test.skip(); return; }
    await expect(page.getByText("Starter")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Professional")).toBeVisible();
    await expect(page.getByText("Enterprise")).toBeVisible();
  });

  test("shows plan prices", async ({ page }) => {
    if (!process.env.E2E_TEST_USERNAME) { test.skip(); return; }
    await expect(page.getByText("$49/mo")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("$199/mo")).toBeVisible();
  });

  test("Enterprise card shows Contact Sales link", async ({ page }) => {
    if (!process.env.E2E_TEST_USERNAME) { test.skip(); return; }
    const contactLink = page.getByRole("link", { name: "Contact Sales" });
    await expect(contactLink).toBeVisible({ timeout: 10_000 });
    await expect(contactLink).toHaveAttribute("href", /mailto:sales@/);
  });

  test("Upgrade button for Starter exists and is clickable", async ({ page }) => {
    if (!process.env.E2E_TEST_USERNAME) { test.skip(); return; }
    // We don't actually complete checkout — just verify the button exists
    const upgradeBtn = page.getByRole("button", { name: "Upgrade" }).first();
    await expect(upgradeBtn).toBeVisible({ timeout: 10_000 });
    await expect(upgradeBtn).toBeEnabled();
  });
});
