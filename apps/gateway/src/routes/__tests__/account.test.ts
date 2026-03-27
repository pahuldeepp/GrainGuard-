import request from "supertest";
import express from "express";

jest.mock("../../database/db", () => ({
  pool:      { query: jest.fn() },
  writePool: { query: jest.fn() },
}));
jest.mock("../../lib/audit", () => ({ writeAuditLog: jest.fn() }));
jest.mock("../../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { sub: "u1", tenantId: "tid-1", roles: ["admin"], role: "admin" };
    next();
  },
}));

import { accountRouter } from "../account";
import { writePool } from "../../database/db";

const app = express();
app.use(express.json());
app.use(accountRouter);

const mockPool = writePool as unknown as { query: jest.Mock; connect: jest.Mock };

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect = jest.fn().mockResolvedValue({
    query: mockPool.query,
    release: jest.fn(),
  });
});

describe("GET /account/me", () => {
  it("returns user, tenant, and device count", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "u1", email: "a@b.com", role: "admin", created_at: "2024-01-01" }] } as any)
      .mockResolvedValueOnce({ rows: [{ id: "tid-1", name: "Acme", slug: "acme", plan: "starter", subscription_status: "active", created_at: "2024-01-01" }] } as any)
      .mockResolvedValueOnce({ rows: [{ device_count: "5" }] } as any);

    const res = await request(app).get("/account/me");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("a@b.com");
    expect(res.body.tenant.name).toBe("Acme");
    expect(res.body.deviceCount).toBe(5);
  });

  it("returns null user when not found", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [{ device_count: "0" }] } as any);

    const res = await request(app).get("/account/me");
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});

describe("DELETE /account/me", () => {
  it("removes user when not last admin", async () => {
    mockPool.query
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "a1" }, { id: "a2" }] } as any) // admins
      .mockResolvedValueOnce({ rows: [{ id: "u1", role: "admin" }] } as any) // user
      .mockResolvedValueOnce({ rowCount: 1 } as any) // DELETE user
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const res = await request(app).delete("/account/me");
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("user");
  });

  it("deletes entire tenant when last admin", async () => {
    mockPool.query
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "a1" }] } as any) // only admin
      .mockResolvedValueOnce({ rows: [{ id: "u1", role: "admin" }] } as any) // user
      .mockResolvedValueOnce(undefined as any) // DELETE invites
      .mockResolvedValueOnce(undefined as any) // DELETE api_keys
      .mockResolvedValueOnce(undefined as any) // DELETE alert_rules
      .mockResolvedValueOnce(undefined as any) // DELETE audit_events
      .mockResolvedValueOnce(undefined as any) // DELETE devices
      .mockResolvedValueOnce(undefined as any) // DELETE tenant_users
      .mockResolvedValueOnce(undefined as any) // DELETE tenants
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const res = await request(app).delete("/account/me");
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("tenant");
  });
});

describe("GET /account/export", () => {
  it("returns all tenant data as JSON", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "tid-1", name: "Acme" }] } as any)
      .mockResolvedValueOnce({ rows: [{ id: "u1", email: "a@b.com" }] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    const res = await request(app).get("/account/export");
    expect(res.status).toBe(200);
    expect(res.body.tenant.name).toBe("Acme");
    expect(res.body.users).toHaveLength(1);
    expect(res.headers["content-disposition"]).toContain("attachment");
  });
});
