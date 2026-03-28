import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlertRulesPage } from "../AlertRulesPage";

// ── Mock auth0 helper ─────────────────────────────────────────────────────────
vi.mock("../../../lib/auth0", () => ({
  getAccessTokenSilently: vi.fn().mockResolvedValue("tok-test"),
  setLoginWithRedirect: vi.fn(),
}));

// ── Mock toast ────────────────────────────────────────────────────────────────
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
function mockFetch(body: unknown, status = 200) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  document.cookie = "_csrf=test-token";
});

const RULE = {
  id: "r1",
  name: "High Temp",
  metric: "temperature",
  operator: ">=",
  threshold: 30,
  device_type: null,
  enabled: true,
  created_at: new Date().toISOString(),
};

describe("AlertRulesPage", () => {
  it("shows loading state then renders rules", async () => {
    mockFetch([RULE]);
    render(<AlertRulesPage />);
    // loading indicator visible first
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("High Temp")).toBeInTheDocument();
  });

  it("shows empty state when no rules exist", async () => {
    mockFetch([]);
    render(<AlertRulesPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText(/no alert rules/i)).toBeInTheDocument();
  });

  it("opens form on 'New Rule' click", async () => {
    mockFetch([]);
    render(<AlertRulesPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /\+ new rule/i }));
    expect(screen.getByRole("button", { name: /create rule/i })).toBeInTheDocument();
  });

  it("creates a new rule and appends to list", async () => {
    // initial load — empty
    mockFetch([]);
    // POST create
    mockFetch({ ...RULE, id: "r-new", name: "Low Battery" });
    // reload after create
    mockFetch([{ ...RULE, id: "r-new", name: "Low Battery" }]);

    render(<AlertRulesPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /\+ new rule/i }));
    const form = screen.getByRole("button", { name: /create rule/i }).closest("form") as HTMLFormElement;

    const nameInput = within(form).getByPlaceholderText(/high temperature alert/i);
    const thresholdInput = within(form).getByPlaceholderText(/e\.g\. 35/i);

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Low Battery");
    await userEvent.clear(thresholdInput);
    await userEvent.type(thresholdInput, "10");

    await userEvent.click(within(form).getByRole("button", { name: /save|create/i }));

    await waitFor(() => expect(screen.getByText("Low Battery")).toBeInTheDocument());
  });

  it("deletes a rule", async () => {
    mockFetch([RULE]);
    // DELETE response
    mockFetch({ deleted: true });
    // reload after delete — empty
    mockFetch([]);

    render(<AlertRulesPage />);
    await waitFor(() => expect(screen.getByText("High Temp")).toBeInTheDocument());

    const deleteBtn = screen.getByRole("button", { name: /delete/i });
    await userEvent.click(deleteBtn);

    await waitFor(() => expect(screen.queryAllByText("High Temp")).toHaveLength(0));
  });

  it("shows toast error when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "internal_error" }),
    } as Response);

    const toast = await import("react-hot-toast");
    render(<AlertRulesPage />);
    await waitFor(() => expect(toast.default.error).toHaveBeenCalled());
  });
});
