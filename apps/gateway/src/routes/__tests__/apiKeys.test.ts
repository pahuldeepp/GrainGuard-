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

import { apiKeysRouter } from "../apiKeys";
import { writePool as pool } from "../../database/db";

const app = express();
app.use(express.json());
app.use(apiKeysRouter);

const mockPool = pool as unknown as { query: jest.Mock };

describe("GET /api-keys", () => {
  it("lists active keys for the tenant", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "k1", name: "CI/CD Key", created_at: new Date().toISOString(), expires_at: null, revoked_at: null, last_used_at: null }],
    } as any);

    const res = await request(app).get("/api-keys");
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("CI/CD Key");
    // key_hash must never be returned
    expect(res.body[0].key_hash).toBeUndefined();
  });
});

describe("POST /api-keys", () => {
  it("creates a key and returns the raw secret once", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "k-new", name: "Deploy Key", created_at: new Date().toISOString(), expires_at: null }],
    } as any);

    const res = await request(app).post("/api-keys").send({ name: "Deploy Key" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Deploy Key");
    // raw key must start with gg_ prefix
    expect(res.body.key).toMatch(/^gg_[0-9a-f]{64}$/);
  });

  it("requires name", async () => {
    const res = await request(app).post("/api-keys").send({});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api-keys/:id", () => {
  it("revokes an active key", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "k1" }] } as any);
    const res = await request(app).delete("/api-keys/k1");
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
  });

  it("returns 404 when key not found or already revoked", async () => {
    mockPool.query.mockResolvedValue({ rows: [] } as any);
    const res = await request(app).delete("/api-keys/gone");
    expect(res.status).toBe(404);
  });
});
