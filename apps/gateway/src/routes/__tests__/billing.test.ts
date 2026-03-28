import request from "supertest";
import express from "express";

process.env.STRIPE_PRICE_STARTER = "price_starter_test";
process.env.STRIPE_PRICE_PROFESSIONAL = "price_pro_test";

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
// Stripe mock — prevents live API calls
jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: {
      retrieve: jest.fn().mockResolvedValue({
        current_period_end:  Math.floor(Date.now() / 1000) + 2592000,
        cancel_at_period_end: false,
        status:              "active",
      }),
    },
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({ url: "https://checkout.stripe.com/test", id: "cs_test" }),
      },
    },
    customers: {
      create: jest.fn().mockResolvedValue({ id: "cus_test" }),
    },
    billingPortal: {
      sessions: {
        create: jest.fn().mockResolvedValue({ url: "https://billing.stripe.com/test" }),
      },
    },
  }));
});

import { billingRouter } from "../billing";
import { writePool } from "../../lib/db";

const app = express();
app.use(express.json());
app.use(billingRouter);

const mockPool = writePool as unknown as { query: jest.Mock };

describe("GET /billing/subscription", () => {
  it("returns free plan when no billing record exists", async () => {
    mockPool.query.mockResolvedValue({ rows: [] } as any);
    const res = await request(app).get("/billing/subscription");
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("free");
    expect(res.body.status).toBe("none");
  });

  it("returns subscription data when a billing record exists", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{
        stripe_customer_id:     "cus_test",
        stripe_subscription_id: "sub_test",
        plan:                   "starter",
        status:                 "active",
        trial_ends_at:          null,
      }],
    } as any);

    const res = await request(app).get("/billing/subscription");
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("starter");
    expect(res.body.status).toBe("active");
  });
});

describe("POST /billing/checkout", () => {
  it("rejects unknown plan names", async () => {
    const res = await request(app).post("/billing/checkout").send({ plan: "diamond" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_plan");
  });

  it("creates checkout session for valid plan", async () => {
    // First query: get existing customer
    mockPool.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: "cus_test" }] } as any);

    const res = await request(app).post("/billing/checkout").send({ plan: "starter" });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("stripe.com");
  });
});
