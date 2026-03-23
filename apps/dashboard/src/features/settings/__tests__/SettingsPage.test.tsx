import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPage } from "../SettingsPage";

// ── Mock auth0 helper ─────────────────────────────────────────────────────────
vi.mock("../../../lib/auth0", () => ({
  getAccessTokenSilently: vi.fn().mockResolvedValue("tok-test"),
  setLoginWithRedirect: vi.fn(),
}));

// ── Mock useAuth ──────────────────────────────────────────────────────────────
vi.mock("../../../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { email: "alice@example.com" },
    signOut: vi.fn(),
  }),
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

const ACCOUNT_DATA = {
  user: { id: "u1", email: "alice@example.com", role: "admin", created_at: "2024-01-01T00:00:00Z" },
  tenant: { id: "t1", name: "Acme Farms", slug: "acme", plan: "starter", subscription_status: "active", created_at: "2024-01-01T00:00:00Z" },
  deviceCount: 12,
  roles: ["admin"],
};

const NOTIF_PREFS = {
  email_alerts: true,
  email_weekly_digest: false,
  webhook_alerts: true,
  alert_levels: ["warn", "critical"],
};

function mockBothLoads() {
  mockFetch(ACCOUNT_DATA);
  mockFetch(NOTIF_PREFS);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  it("shows loading state initially", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    render(<SettingsPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders user profile after load", async () => {
    mockBothLoads();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("renders organisation info", async () => {
    mockBothLoads();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("Organisation")).toBeInTheDocument();
    expect(screen.getByText("Acme Farms")).toBeInTheDocument();
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("renders notification preferences with toggles", async () => {
    mockBothLoads();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("Notification Preferences")).toBeInTheDocument();
    expect(screen.getByText("Email alerts")).toBeInTheDocument();
    expect(screen.getByText("Weekly digest email")).toBeInTheDocument();
    expect(screen.getByText("Webhook alerts")).toBeInTheDocument();
  });

  it("saves notification preferences on toggle", async () => {
    mockBothLoads();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    // Mock the PUT response for saving preferences
    mockFetch({ ...NOTIF_PREFS, email_weekly_digest: true });

    // Click the "Weekly digest email" toggle (the second toggle button)
    const toggleButtons = screen.getAllByRole("button").filter(
      (btn) => btn.className.includes("rounded-full") && btn.className.includes("w-11"),
    );
    await userEvent.click(toggleButtons[1]); // weekly digest toggle

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/notifications/preferences"),
        expect.objectContaining({ method: "PUT" }),
      );
    });
  });

  it("shows data export button", async () => {
    mockBothLoads();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("Export My Data")).toBeInTheDocument();
  });

  it("shows delete account button", async () => {
    mockBothLoads();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("Delete Account")).toBeInTheDocument();
    expect(screen.getByText("Danger Zone")).toBeInTheDocument();
  });
});
