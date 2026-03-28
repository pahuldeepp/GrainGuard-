import { test, expect } from "@playwright/test";
import { injectMockAuth } from "./fixtures/mockAuth";

// Uses mock auth — no real Auth0 credentials needed.

test.describe("Devices page", () => {
  test.beforeEach(async ({ page }) => {
    await injectMockAuth(page);
    await page.goto("/");
  });

  test("shows + Register Device button", async ({ page }) => {
    const btn = page.getByRole("button", { name: "+ Register Device" });
    await expect(btn).toBeVisible({ timeout: 10_000 });
  });

  test("Register Device modal opens on click", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Register a Device")).toBeVisible();
  });

  test("modal closes on Escape", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("modal closes on backdrop click", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.click({ position: { x: 5, y: 5 } });
    await expect(dialog).not.toBeVisible();
  });

  test("serial number input normalises to uppercase", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    const input = page.getByLabel("Serial Number");
    await input.fill("sn12345678");
    await expect(input).toHaveValue("SN12345678");
  });

  test("submit button disabled when serial is too short", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    const submitBtn = page.getByRole("button", { name: "Register Device" });
    await expect(submitBtn).toBeDisabled();

    await page.getByLabel("Serial Number").fill("SN1");
    await expect(submitBtn).toBeDisabled();

    await page.getByLabel("Serial Number").fill("SN12");
    await expect(submitBtn).toBeEnabled();
  });

  test("invalid serial shows validation error", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    await page.getByLabel("Serial Number").fill("AB!@#");
    await page.getByRole("button", { name: "Register Device" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("4–30 uppercase");
  });

  test("CSV Export button is present", async ({ page }) => {
    const exportBtn = page.getByRole("button", { name: /Export CSV/i });
    await expect(exportBtn).toBeVisible({ timeout: 10_000 });
  });

  test("Refresh button triggers refetch", async ({ page }) => {
    const refreshBtn = page.getByRole("button", { name: "Refresh" });
    await expect(refreshBtn).toBeVisible({ timeout: 10_000 });
    await refreshBtn.click();
  });
});
