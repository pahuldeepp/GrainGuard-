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
jest.mock("../../lib/auth0Management", () => ({
  createOrganization: jest.fn().mockResolvedValue({ orgId: "org-123" }),
  createSamlConnection: jest.fn().mockResolvedValue({ connectionId: "con-saml" }),
  createOidcConnection: jest.fn().mockResolvedValue({ connectionId: "con-oidc" }),
  enableConnectionOnOrg: jest.fn().mockResolvedValue(undefined),
  disableConnectionOnOrg: jest.fn().mockResolvedValue(undefined),
  listOrgConnections: jest.fn().mockResolvedValue([{ connectionId: "con-1", strategy: "saml" }]),
}));

import { ssoRouter } from "../sso";
import { writePool as pool } from "../../database/db";
import { listOrgConnections } from "../../lib/auth0Management";

const app = express();
app.use(express.json());
app.use(ssoRouter);

const mockPool = pool as unknown as { query: jest.Mock };
const mockListOrgConnections = listOrgConnections as jest.Mock;

describe("GET /tenants/me/sso", () => {
  it("returns unconfigured state when no org exists", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ auth0_org_id: null }] } as any);
    const res = await request(app).get("/tenants/me/sso");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });

  it("returns connections when org exists", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ auth0_org_id: "org-123" }] } as any);
    const res = await request(app).get("/tenants/me/sso");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.connections).toHaveLength(1);
  });

  it("returns a soft warning when Auth0 management is unavailable", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ auth0_org_id: "org-123" }] } as any);
    mockListOrgConnections.mockRejectedValueOnce(new Error("SSO not configured"));
    const res = await request(app).get("/tenants/me/sso");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.connections).toEqual([]);
    expect(res.body.warning).toContain("Auth0 management API");
  });
});

describe("POST /tenants/me/sso/org", () => {
  it("creates org", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ auth0_org_id: null, name: "Acme" }] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);
    const res = await request(app).post("/tenants/me/sso/org");
    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe("org-123");
  });
});

describe("POST /tenants/me/sso/saml", () => {
  it("configures SAML", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ auth0_org_id: "org-123" }] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);
    const res = await request(app).post("/tenants/me/sso/saml").send({
      name: "Okta", signInUrl: "https://okta.com/sso", signingCert: "base64cert", emailDomains: ["acme.com"],
    });
    expect(res.status).toBe(201);
    expect(res.body.connectionId).toBe("con-saml");
  });
});

describe("DELETE /tenants/me/sso", () => {
  it("disables SSO", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ auth0_org_id: "org-123", sso_connection_id: "con-1" }] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);
    const res = await request(app).delete("/tenants/me/sso");
    expect(res.status).toBe(200);
    expect(res.body.disabled).toBe(true);
  });
});
