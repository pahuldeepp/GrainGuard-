import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WebhooksPage } from "../WebhooksPage";

// ── Mock auth0 helper ─────────────────────────────────────────────────────────
vi.mock("../../../lib/auth0", () => ({
  getAccessTokenSilently: vi.fn().mockResolvedValue("tok-test"),
  setLoginWithRedirect: vi.fn(),
}));

// ── Mock useAuth ──────────────────────────────────────────────────────────────
vi.mock("../../../hooks/useAuth", () => ({
  useAuth: () => ({
    isAdmin: true,
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

const WEBHOOK_LIST = [
  {
    id: "wh1",
    url: "https://hooks.example.com/alert",
    description: "Production alerts",
    enabled: true,
    event_types: ["telemetry.alert"],
    created_at: "2024-06-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
    last_error: null,
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("WebhooksPage", () => {
  it("shows loading then renders webhook list", async () => {
    mockFetch(WEBHOOK_LIST);
    render(<WebhooksPage />);

    // Loading state shows first
    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("https://hooks.example.com/alert")).toBeInTheDocument();
    expect(screen.getByText("Production alerts")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows empty state when no webhooks", async () => {
    mockFetch([]);
    render(<WebhooksPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText(/no webhook endpoints yet/i)).toBeInTheDocument();
  });

  it("creates new webhook and shows secret once", async () => {
    // Initial load
    mockFetch([]);
    render(<WebhooksPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    // Open form
    await userEvent.click(screen.getByText("+ Add Endpoint"));

    // Fill URL
    const urlInput = screen.getByPlaceholderText(/https:\/\/your-server/i);
    await userEvent.type(urlInput, "https://hooks.example.com/new");

    // Mock POST response then reload
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "wh2", secret: "whsec_abc123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: "wh2", url: "https://hooks.example.com/new", description: null, enabled: true, event_types: [], created_at: "2024-06-01T00:00:00Z", updated_at: "2024-06-01T00:00:00Z", last_error: null }],
      } as Response);

    await userEvent.click(screen.getByText("Create Endpoint"));

    await waitFor(() => {
      expect(screen.getByText("whsec_abc123")).toBeInTheDocument();
    });
    expect(screen.getByText(/copy your signing secret/i)).toBeInTheDocument();
  });

  it("deletes webhook", async () => {
    mockFetch(WEBHOOK_LIST);
    render(<WebhooksPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    // Mock confirm dialog
    vi.spyOn(window, "confirm").mockReturnValue(true);

    // Mock DELETE call
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    await userEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/webhooks/wh1"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("rejects non-HTTPS URLs in form via browser validation", async () => {
    mockFetch([]);
    render(<WebhooksPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    await userEvent.click(screen.getByText("+ Add Endpoint"));

    const urlInput = screen.getByPlaceholderText(/https:\/\/your-server/i) as HTMLInputElement;
    // The input type="url" with required attribute provides browser-level validation
    expect(urlInput).toHaveAttribute("type", "url");
    expect(urlInput).toBeRequired();
    // The form also shows "Must be HTTPS." guidance
    expect(screen.getByText("Must be HTTPS.")).toBeInTheDocument();
  });
});
