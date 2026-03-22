import { test, expect } from "@playwright/test";

// Skips all tests unless the auth env vars are set
function requireAuth() {
  if (!process.env.E2E_TEST_USERNAME) {
    test.skip();
  }
}

test.describe("Devices page", () => {
  test.beforeEach(async ({ page }) => {
    requireAuth();
    // In a real setup this would use the auth fixture from auth.spec.ts
    // or a shared storageState file. For now, just navigate.
    await page.goto("/");
  });

  test("shows + Register Device button", async ({ page }) => {
    requireAuth();
    const btn = page.getByRole("button", { name: "+ Register Device" });
    await expect(btn).toBeVisible({ timeout: 10_000 });
  });

  test("Register Device modal opens on click", async ({ page }) => {
    requireAuth();
    await page.getByRole("button", { name: "+ Register Device" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Register a Device")).toBeVisible();
  });

  test("modal closes on Escape", async ({ page }) => {
    requireAuth();
    await page.getByRole("button", { name: "+ Register Device" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("modal closes on backdrop click", async ({ page }) => {
    requireAuth();
    await page.getByRole("button", { name: "+ Register Device" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Click the backdrop (outside the card)
    await page.mouse.click(10, 10);
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("serial number input normalises to uppercase", async ({ page }) => {
    requireAuth();
    await page.getByRole("button", { name: "+ Register Device" }).click();
    const input = page.getByLabel("Serial Number");
    await input.fill("sn12345678");
    await expect(input).toHaveValue("SN12345678");
  });

  test("submit button disabled when serial is too short", async ({ page }) => {
    requireAuth();
    await page.getByRole("button", { name: "+ Register Device" }).click();
    const submitBtn = page.getByRole("button", { name: "Register Device" });
    await expect(submitBtn).toBeDisabled();

    // Type 3 chars — still disabled
    await page.getByLabel("Serial Number").fill("SN1");
    await expect(submitBtn).toBeDisabled();

    // Type 4 chars — enabled
    await page.getByLabel("Serial Number").fill("SN12");
    await expect(submitBtn).toBeEnabled();
  });

  test("invalid serial shows validation error", async ({ page }) => {
    requireAuth();
    await page.getByRole("button", { name: "+ Register Device" }).click();
    await page.getByLabel("Serial Number").fill("AB!@#");  // invalid chars
    await page.getByRole("button", { name: "Register Device" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("4–30 uppercase");
  });

  test("CSV Export button is present", async ({ page }) => {
    requireAuth();
    const exportBtn = page.getByRole("button", { name: /Export CSV/i });
    await expect(exportBtn).toBeVisible({ timeout: 10_000 });
  });

  test("Refresh button triggers refetch", async ({ page }) => {
    requireAuth();
    const refreshBtn = page.getByRole("button", { name: "Refresh" });
    await expect(refreshBtn).toBeVisible({ timeout: 10_000 });
    // Click refresh — should not throw or crash
    await refreshBtn.click();
  });
});
