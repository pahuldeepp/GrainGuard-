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

import { webhooksRouter } from "../webhooks";
import { writePool } from "../../lib/db";

const app = express();
app.use(express.json());
app.use(webhooksRouter);

const mockPool = writePool as unknown as { query: jest.Mock };

describe("GET /webhooks", () => {
  it("lists endpoints without exposing secrets", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "wh1", url: "https://example.com/hook", description: "Test", enabled: true, event_types: ["telemetry.alert"] }],
    } as any);

    const res = await request(app).get("/webhooks");
    expect(res.status).toBe(200);
    expect(res.body[0].url).toBe("https://example.com/hook");
    expect(res.body[0].secret).toBeUndefined();
  });
});

describe("POST /webhooks", () => {
  it("creates endpoint with HTTPS URL", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "wh-new", url: "https://example.com/hook", description: null, enabled: true, event_types: [], created_at: new Date().toISOString() }],
    } as any);

    const res = await request(app).post("/webhooks").send({ url: "https://example.com/hook" });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_/);
  });

  it("rejects non-HTTPS URL", async () => {
    const res = await request(app).post("/webhooks").send({ url: "http://example.com/hook" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("HTTPS");
  });

  it("rejects empty URL", async () => {
    const res = await request(app).post("/webhooks").send({ url: "" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /webhooks/:id", () => {
  it("updates endpoint", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "wh1", url: "https://example.com/hook", description: "Updated", enabled: false }],
    } as any);

    const res = await request(app).patch("/webhooks/wh1").send({ description: "Updated", enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("Updated");
  });
});

describe("DELETE /webhooks/:id", () => {
  it("deletes endpoint", async () => {
    mockPool.query.mockResolvedValue({ rowCount: 1 } as any);
    const res = await request(app).delete("/webhooks/wh1");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 when not found", async () => {
    mockPool.query.mockResolvedValue({ rowCount: 0 } as any);
    const res = await request(app).delete("/webhooks/gone");
    expect(res.status).toBe(404);
  });
});
