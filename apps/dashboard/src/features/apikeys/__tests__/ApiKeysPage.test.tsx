import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiKeysPage } from "../ApiKeysPage";

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

const API_KEYS = [
  {
    id: "k1",
    name: "Silo A sensors",
    created_at: "2024-03-01T00:00:00Z",
    expires_at: "2025-03-01T00:00:00Z",
    revoked_at: null,
    last_used_at: "2024-06-15T00:00:00Z",
  },
  {
    id: "k2",
    name: "Old key",
    created_at: "2023-01-01T00:00:00Z",
    expires_at: null,
    revoked_at: "2024-01-01T00:00:00Z",
    last_used_at: null,
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ApiKeysPage", () => {
  it("lists existing API keys", async () => {
    mockFetch(API_KEYS);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("Silo A sensors")).toBeInTheDocument();
    // Revoked key section
    expect(screen.getByText("Revoked Keys")).toBeInTheDocument();
    expect(screen.getByText("Old key")).toBeInTheDocument();
  });

  it("creates new key and shows raw secret", async () => {
    mockFetch([]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    // Open form
    await userEvent.click(screen.getByText("+ New Key"));

    // Fill name
    const nameInput = screen.getByPlaceholderText(/silo a sensors/i);
    await userEvent.type(nameInput, "Test Key");

    // Mock POST then reload
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "k3", key: "gg_secret_abc123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: "k3", name: "Test Key", created_at: "2024-06-01T00:00:00Z", expires_at: null, revoked_at: null, last_used_at: null }],
      } as Response);

    await userEvent.click(screen.getByText("Create Key"));

    await waitFor(() => {
      expect(screen.getByText("gg_secret_abc123")).toBeInTheDocument();
    });
    expect(screen.getByText(/copy your api key now/i)).toBeInTheDocument();
  });

  it("deletes/revokes a key", async () => {
    mockFetch([API_KEYS[0]]); // only active key
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    vi.spyOn(window, "confirm").mockReturnValue(true);

    // Mock DELETE then reload
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      } as Response);

    await userEvent.click(screen.getByText("Revoke"));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api-keys/k1"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("shows empty state", async () => {
    mockFetch([]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument();
  });
});
