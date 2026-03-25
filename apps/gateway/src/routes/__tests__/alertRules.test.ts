import request from "supertest";
import express from "express";

// ── Mocks (hoisted before imports) ────────────────────────────────────────
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

import { alertRulesRouter } from "../alertRules";
import { pool } from "../../lib/db";

const app = express();
app.use(express.json());
app.use(alertRulesRouter);

const mockPool = pool as jest.Mocked<typeof pool>;

// ── Tests ─────────────────────────────────────────────────────────────────

describe("GET /alert-rules", () => {
  it("returns the tenant's alert rules", async () => {
    const rows = [
      { id: "r1", name: "High Temp", metric: "temperature", operator: ">=", threshold: 30, level: "warn", enabled: true },
    ];
    mockPool.query.mockResolvedValue({ rows } as any);

    const res = await request(app).get("/alert-rules");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("High Temp");
  });

  it("returns empty array when no rules exist", async () => {
    mockPool.query.mockResolvedValue({ rows: [] } as any);
    const res = await request(app).get("/alert-rules");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("POST /alert-rules", () => {
  const validRule = { name: "Critical Humidity", metric: "humidity", operator: ">=", threshold: 80, level: "critical" };

  it("creates a new alert rule", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "r-new", ...validRule, enabled: true }] } as any);

    const res = await request(app).post("/alert-rules").send(validRule);

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Critical Humidity");
  });

  it("rejects an unknown metric", async () => {
    const res = await request(app).post("/alert-rules").send({ ...validRule, metric: "radioactivity" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metric/);
  });

  it("rejects an unknown operator", async () => {
    const res = await request(app).post("/alert-rules").send({ ...validRule, operator: "!==" });
    expect(res.status).toBe(400);
  });

  it("requires name field", async () => {
    const { name: _, ...noName } = validRule;
    const res = await request(app).post("/alert-rules").send(noName);
    expect(res.status).toBe(400);
  });

  it("requires threshold field", async () => {
    const res = await request(app).post("/alert-rules").send({ name: "X", metric: "temperature", operator: ">=" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /alert-rules/:id", () => {
  it("deletes an existing rule", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "r1" }], rowCount: 1 } as any);
    const res = await request(app).delete("/alert-rules/r1");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 when rule not found", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);
    const res = await request(app).delete("/alert-rules/unknown");
    expect(res.status).toBe(404);
  });
});
