import request from "supertest";
import express from "express";

jest.mock("../../lib/db", () => ({
  pool:      { query: jest.fn() },
  writePool: { query: jest.fn() },
}));
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
jest.mock("../../lib/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { sub: "u1", tenantId: "tid-1", roles: ["admin"], role: "admin" };
    next();
  },
}));
jest.mock("uuid", () => ({ v4: () => "mock-uuid" }));
jest.mock("../../lib/auth0-mgmt", () => ({
  setUserTenantId: jest.fn().mockResolvedValue(undefined),
  assignRoleByName: jest.fn().mockResolvedValue(undefined),
  inviteToOrg: jest.fn().mockResolvedValue(undefined),
}));

import { teamRouter } from "../teamMembers";
import { pool } from "../../lib/db";

const app = express();
app.use(express.json());
app.use(teamRouter);

const mockPool = pool as jest.Mocked<typeof pool>;

describe("GET /team/members", () => {
  it("lists members", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "m1", auth_user_id: "u1", email: "a@b.com", role: "admin", created_at: "2024-01-01" }],
    } as any);
    const res = await request(app).get("/team/members");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].email).toBe("a@b.com");
  });
});

describe("POST /team/invite", () => {
  it("creates invite", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] } as any) // no existing member
      .mockResolvedValueOnce({ rows: [] } as any) // no pending invite
      .mockResolvedValueOnce({ rowCount: 1 } as any); // INSERT

    const res = await request(app).post("/team/invite").send({ email: "new@b.com" });
    expect(res.status).toBe(201);
    expect(res.body.invited).toBe(true);
  });

  it("rejects missing email", async () => {
    const res = await request(app).post("/team/invite").send({});
    expect(res.status).toBe(400);
  });

  it("rejects duplicate member", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: "m1" }] } as any);
    const res = await request(app).post("/team/invite").send({ email: "dup@b.com" });
    expect(res.status).toBe(409);
  });
});

describe("GET /team/invite/info", () => {
  it("returns invite info by token", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "inv1", tenant_name: "Acme", role: "member", expires_at: new Date(Date.now() + 86400000).toISOString(), accepted_at: null }],
    } as any);
    const res = await request(app).get("/team/invite/info?token=abc");
    expect(res.status).toBe(200);
    expect(res.body.tenantName).toBe("Acme");
  });

  it("returns 410 for expired invite", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "inv1", tenant_name: "Acme", role: "member", expires_at: new Date("2020-01-01").toISOString(), accepted_at: null }],
    } as any);
    const res = await request(app).get("/team/invite/info?token=old");
    expect(res.status).toBe(410);
  });
});

describe("PUT /team/members/:id/role", () => {
  it("changes role", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "m1", auth_user_id: "u2", email: "b@b.com", role: "member" }],
    } as any);
    const res = await request(app).put("/team/members/m1/role").send({ role: "member" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("member");
  });
});

describe("DELETE /team/members/:id", () => {
  it("removes member", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ auth_user_id: "u2", email: "b@b.com" }] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);
    const res = await request(app).delete("/team/members/m2");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("cannot remove self", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ auth_user_id: "u1", email: "a@b.com" }] } as any);
    const res = await request(app).delete("/team/members/m1");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cannot_remove_self");
  });
});
