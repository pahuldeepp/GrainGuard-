import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingPage } from "../BillingPage";

// ── Mock auth0 helper ─────────────────────────────────────────────────────────
vi.mock("../../../lib/auth0", () => ({
  getAccessTokenSilently: vi.fn().mockResolvedValue("tok-test"),
  setLoginWithRedirect: vi.fn(),
}));

// ── Mock react-hot-toast ──────────────────────────────────────────────────────
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const mockFetch = (body: unknown, status = 200) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("BillingPage", () => {
  it("shows loading state initially", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    render(<BillingPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders free plan badge when subscription_status is 'none'", async () => {
    mockFetch({ plan: "free", subscription_status: "none", trial_ends_at: null, current_period_end: null });
    render(<BillingPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText(/free/i)).toBeInTheDocument();
  });

  it("renders current plan when subscription is active", async () => {
    mockFetch({
      plan: "starter",
      subscription_status: "active",
      trial_ends_at: null,
      current_period_end: new Date(Date.now() + 86400_000).toISOString(),
    });
    render(<BillingPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    // Plan name should appear (case-insensitive)
    expect(screen.getByText(/starter/i)).toBeInTheDocument();
  });

  it("shows all three plan cards", async () => {
    mockFetch({ plan: "free", subscription_status: "none", trial_ends_at: null, current_period_end: null });
    render(<BillingPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText("Professional")).toBeInTheDocument();
    expect(screen.getByText("Enterprise")).toBeInTheDocument();
  });

  it("redirects to Stripe checkout on upgrade click", async () => {
    // GET subscription
    mockFetch({ plan: "free", subscription_status: "none", trial_ends_at: null, current_period_end: null });
    // POST checkout
    mockFetch({ url: "https://checkout.stripe.com/test" });

    // Intercept window.location.href assignment
    const assignSpy = vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      href: "",
      assign: vi.fn(),
    } as unknown as Location);

    render(<BillingPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    const upgradeButtons = screen.getAllByRole("button", { name: /upgrade|get started/i });
    await userEvent.click(upgradeButtons[0]);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/billing/checkout"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    assignSpy.mockRestore();
  });

  it("shows error message when subscription fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);
    render(<BillingPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText(/http 500/i)).toBeInTheDocument();
  });
});
