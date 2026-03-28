import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
  document.cookie = "_csrf=test-token";
});

function mockWindowLocation() {
  const location = {
    ...window.location,
    href: "http://localhost/billing",
    origin: "http://localhost",
    assign: vi.fn(),
    replace: vi.fn(),
  } as unknown as Location;

  Object.defineProperty(window, "location", {
    configurable: true,
    value: location,
  });

  return location;
}

function renderPage(initialEntry = "/billing") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <BillingPage />
    </MemoryRouter>
  );
}

describe("BillingPage", () => {
  it("renders starter state when no paid subscription is active", async () => {
    mockFetch({ plan: "free", status: "none", trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, paymentFailed: false });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Starter" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /manage/i })).not.toBeInTheDocument();
  });

  it("renders current plan when subscription is active", async () => {
    mockFetch({
      plan: "starter",
      status: "active",
      trialEndsAt: null,
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400,
      cancelAtPeriodEnd: false,
      paymentFailed: false,
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /manage/i })).toBeInTheDocument());
    expect(screen.getByText(/renews/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /current plan/i })).toBeInTheDocument();
  });

  it("shows all three plan cards", async () => {
    mockFetch({ plan: "free", status: "none", trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, paymentFailed: false });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Starter" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Professional" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Enterprise" })).toBeInTheDocument();
  });

  it("redirects to Stripe checkout on upgrade click", async () => {
    const location = mockWindowLocation();

    // GET subscription
    mockFetch({ plan: "free", status: "none", trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, paymentFailed: false });
    // POST checkout
    mockFetch({ url: "https://checkout.stripe.com/test" });

    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Starter" })).toBeInTheDocument());

    const upgradeButtons = screen.getAllByRole("button", { name: /upgrade/i });
    await userEvent.click(upgradeButtons[0]);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/billing/checkout"),
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(location.href).toBe("https://checkout.stripe.com/test");

  });

  it("shows error message when subscription fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Starter" })).toBeInTheDocument());
    expect(screen.getByText(/billing & plans/i)).toBeInTheDocument();
  });
});
