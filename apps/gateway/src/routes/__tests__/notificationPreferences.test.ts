import request from "supertest";
import express from "express";

jest.mock("../../database/db", () => ({
  pool:      { query: jest.fn() },
  writePool: { query: jest.fn() },
}));
jest.mock("../../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { sub: "u1", tenantId: "tid-1", roles: ["admin"], role: "admin" };
    next();
  },
}));

import { notificationPrefsRouter } from "../notificationPreferences";
import { writePool as pool } from "../../database/db";

const app = express();
app.use(express.json());
app.use(notificationPrefsRouter);

const mockPool = pool as unknown as { query: jest.Mock };

describe("GET /notifications/preferences", () => {
  it("returns defaults when no prefs exist", async () => {
    mockPool.query.mockResolvedValue({ rows: [] } as any);
    const res = await request(app).get("/notifications/preferences");
    expect(res.status).toBe(200);
    expect(res.body.email_alerts).toBe(true);
    expect(res.body.email_weekly_digest).toBe(true);
    expect(res.body.webhook_alerts).toBe(false);
    expect(res.body.alert_levels).toEqual(["warn", "critical"]);
  });

  it("returns saved prefs", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "p1", email_alerts: false, email_weekly_digest: true, webhook_alerts: true, alert_levels: ["critical"], updated_at: "2024-01-01" }],
    } as any);
    const res = await request(app).get("/notifications/preferences");
    expect(res.status).toBe(200);
    expect(res.body.email_alerts).toBe(false);
    expect(res.body.webhook_alerts).toBe(true);
  });
});

describe("PUT /notifications/preferences", () => {
  it("creates/updates prefs", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: "p1", email_alerts: true, email_weekly_digest: false, webhook_alerts: true, alert_levels: ["critical"], updated_at: "2024-01-01" }],
    } as any);
    const res = await request(app).put("/notifications/preferences").send({ emailAlerts: true, emailWeeklyDigest: false, webhookAlerts: true, alertLevels: ["critical"] });
    expect(res.status).toBe(200);
    expect(res.body.email_weekly_digest).toBe(false);
  });

  it("rejects invalid alert levels", async () => {
    const res = await request(app).put("/notifications/preferences").send({ alertLevels: ["extreme"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("alertLevels");
  });
});
