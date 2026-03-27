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
    await expect(page.getByRole("heading", { name: "Register Device" })).toBeVisible();
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
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("serial number input normalises to uppercase", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    const input = page.getByRole("textbox", { name: "Serial Number", exact: true });
    await input.click();
    await input.pressSequentially("sn12345678");
    await expect(input).toHaveValue("SN12345678");
  });

  test("submit button disabled when serial is too short", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    const submitBtn = page.getByRole("button", { name: "Register Device", exact: true });
    await expect(submitBtn).toBeDisabled();

    const input = page.getByRole("textbox", { name: "Serial Number", exact: true });
    await input.click();
    await input.pressSequentially("SN");
    await expect(submitBtn).toBeDisabled();

    await input.click();
    await input.pressSequentially("1");
    await expect(submitBtn).toBeEnabled();
  });

  test("invalid serial shows validation error", async ({ page }) => {
    await page.getByRole("button", { name: "+ Register Device" }).click();
    const input = page.getByRole("textbox", { name: "Serial Number", exact: true });
    await input.click();
    await input.pressSequentially("AB!@#");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Only letters, numbers, hyphens and underscores allowed");
  });

  test("CSV Export button is present", async ({ page }) => {
    const exportBtn = page.getByRole("button", { name: /Export CSV/i });
    await expect(exportBtn).toBeVisible({ timeout: 10_000 });
  });

  test("Refresh button triggers refetch", async ({ page }) => {
    const refreshBtn = page.getByRole("button", { name: "Refresh" });
    await expect(refreshBtn).toBeVisible({ timeout: 10_000 });
    const refreshRequest = page.waitForResponse((response) =>
      response.url().includes("/graphql") &&
      response.request().method() === "POST" &&
      /devices|Devices/.test(response.request().postData() ?? "")
    );
    await refreshBtn.click();
    await refreshRequest;
  });
});
