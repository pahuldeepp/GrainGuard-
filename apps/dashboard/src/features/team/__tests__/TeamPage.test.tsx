import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamPage } from "../TeamPage";

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

const MEMBERS = [
  { id: "m1", auth_user_id: "auth1", email: "alice@example.com", role: "admin", created_at: "2024-01-01T00:00:00Z" },
  { id: "m2", auth_user_id: "auth2", email: "bob@example.com", role: "member", created_at: "2024-03-15T00:00:00Z" },
];

const INVITES = [
  { id: "inv1", email: "charlie@example.com", role: "member", accepted_at: null, expires_at: "2099-12-31T00:00:00Z", created_at: "2024-06-01T00:00:00Z" },
];

function mockInitialLoad() {
  mockFetch(MEMBERS);  // GET /team/members
  mockFetch(INVITES);  // GET /team/invites
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("TeamPage", () => {
  it("lists team members", async () => {
    mockInitialLoad();
    render(<TeamPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("shows invite form", async () => {
    mockInitialLoad();
    render(<TeamPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    await userEvent.click(screen.getByText("+ Invite Member"));
    expect(screen.getByRole("heading", { name: "Send Invite" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("colleague@example.com")).toBeInTheDocument();
  });

  it("invites new member", async () => {
    mockInitialLoad();
    render(<TeamPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    await userEvent.click(screen.getByText("+ Invite Member"));

    const emailInput = screen.getByPlaceholderText("colleague@example.com");
    await userEvent.type(emailInput, "dave@example.com");

    // Mock POST invite then reload (members + invites)
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "inv2" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MEMBERS,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          ...INVITES,
          { id: "inv2", email: "dave@example.com", role: "member", accepted_at: null, expires_at: "2099-12-31T00:00:00Z", created_at: "2024-06-15T00:00:00Z" },
        ],
      } as Response);

    await userEvent.click(screen.getByRole("button", { name: "Send Invite" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/team/invite"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("removes a member", async () => {
    mockInitialLoad();
    render(<TeamPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    // Mock DELETE call
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    // Click the first Remove button
    const removeButtons = screen.getAllByText("Remove");
    await userEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/team/members/m1"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("shows pending invites", async () => {
    mockInitialLoad();
    render(<TeamPage />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByText("Pending Invites")).toBeInTheDocument();
    expect(screen.getByText("charlie@example.com")).toBeInTheDocument();
  });
});
