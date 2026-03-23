import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { apiRateLimiter } from "../middleware/rateLimiting";
import { writePool as pool } from "../database/db";
import {
  createOrganization,
  createSamlConnection,
  createOidcConnection,
  enableConnectionOnOrg,
  disableConnectionOnOrg,
  listOrgConnections,
} from "../lib/auth0Management";

export const ssoRouter = Router();

ssoRouter.use(apiRateLimiter);

// All SSO routes require the caller to be an admin of the tenant
function requireAdmin(req: Request, res: Response): boolean {
  if (!req.user!.roles?.includes("admin")) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

// ── GET /tenants/me/sso ────────────────────────────────────────────────────────
// Returns the tenant's Auth0 org ID and list of enabled SSO connections.
ssoRouter.get(
  "/tenants/me/sso",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const { rows } = await pool.query(
      "SELECT auth0_org_id FROM tenants WHERE id = $1",
      [req.user!.tenantId]
    );

    if (!rows[0]?.auth0_org_id) {
      // SSO not yet configured — return empty state
      return res.json({ configured: false, connections: [] });
    }

    const orgId = rows[0].auth0_org_id;
    const connections = await listOrgConnections(orgId);

    return res.json({ configured: true, orgId, connections });
  }
);

// ── POST /tenants/me/sso/org ───────────────────────────────────────────────────
// Creates the Auth0 Organization for this tenant (idempotent — skips if exists).
// Must be called before setting up any SSO connection.
ssoRouter.post(
  "/tenants/me/sso/org",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const tenantId = req.user!.tenantId;

    // Check if org already exists
    const { rows } = await pool.query(
      "SELECT auth0_org_id, name FROM tenants WHERE id = $1",
      [tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: "tenant_not_found" });

    if (rows[0].auth0_org_id) {
      // Already created — return the existing ID
      return res.json({ orgId: rows[0].auth0_org_id, created: false });
    }

    // Create Auth0 Organization
    const { orgId } = await createOrganization(tenantId, rows[0].name);

    // Persist the org ID so we reference it in future SSO calls
    await pool.query(
      "UPDATE tenants SET auth0_org_id = $1 WHERE id = $2",
      [orgId, tenantId]
    );

    return res.status(201).json({ orgId, created: true });
  }
);

// ── POST /tenants/me/sso/saml ─────────────────────────────────────────────────
// Configures a SAML 2.0 connection (Okta, ADFS, PingIdentity, etc.).
// Body: { name, signInUrl, signingCert, emailDomains }
ssoRouter.post(
  "/tenants/me/sso/saml",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const tenantId = req.user!.tenantId;

    const { name, signInUrl, signingCert, emailDomains } = req.body as {
      name:         string;
      signInUrl:    string;
      signingCert:  string;   // base64 X.509 certificate
      emailDomains: string[];
    };

    if (!name || !signInUrl || !signingCert || !emailDomains?.length) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // Get the Auth0 Org ID
    const { rows } = await pool.query(
      "SELECT auth0_org_id FROM tenants WHERE id = $1",
      [tenantId]
    );
    if (!rows[0]?.auth0_org_id) {
      return res.status(409).json({ error: "org_not_created", hint: "Call POST /tenants/me/sso/org first" });
    }

    const orgId = rows[0].auth0_org_id;

    // Create the SAML connection in Auth0
    const { connectionId } = await createSamlConnection({
      tenantId, name, signInUrl, signingCert, emailDomains,
    });

    // Enable it on the org — JIT provisioning is on
    await enableConnectionOnOrg(orgId, connectionId);

    // Persist connection ID for future management
    await pool.query(
      `UPDATE tenants
         SET sso_connection_id   = $1,
             sso_connection_type = 'saml'
       WHERE id = $2`,
      [connectionId, tenantId]
    );

    return res.status(201).json({
      connectionId,
      // ACS URL the customer configures in their IdP
      acsUrl: `https://${process.env.AUTH0_DOMAIN}/login/callback?connection=saml-${tenantId}`,
      entityId: `urn:auth0:${process.env.AUTH0_DOMAIN}:saml-${tenantId}`,
    });
  }
);

// ── POST /tenants/me/sso/oidc ─────────────────────────────────────────────────
// Configures an OIDC connection (Azure AD, Google Workspace, Keycloak).
// Body: { name, discoveryUrl, clientId, clientSecret, emailDomains }
ssoRouter.post(
  "/tenants/me/sso/oidc",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const tenantId = req.user!.tenantId;

    const { name, discoveryUrl, clientId, clientSecret, emailDomains } = req.body as {
      name:         string;
      discoveryUrl: string;  // e.g. https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration
      clientId:     string;
      clientSecret: string;
      emailDomains: string[];
    };

    if (!name || !discoveryUrl || !clientId || !clientSecret || !emailDomains?.length) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const { rows } = await pool.query(
      "SELECT auth0_org_id FROM tenants WHERE id = $1",
      [tenantId]
    );
    if (!rows[0]?.auth0_org_id) {
      return res.status(409).json({ error: "org_not_created" });
    }

    const { connectionId } = await createOidcConnection({
      tenantId, name, discoveryUrl, clientId, clientSecret, emailDomains,
    });

    await enableConnectionOnOrg(rows[0].auth0_org_id, connectionId);

    await pool.query(
      `UPDATE tenants
         SET sso_connection_id   = $1,
             sso_connection_type = 'oidc'
       WHERE id = $2`,
      [connectionId, tenantId]
    );

    return res.status(201).json({ connectionId });
  }
);

// ── DELETE /tenants/me/sso ────────────────────────────────────────────────────
// Disables SSO for this tenant (unlinks connection from org).
ssoRouter.delete(
  "/tenants/me/sso",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const tenantId = req.user!.tenantId;

    const { rows } = await pool.query(
      "SELECT auth0_org_id, sso_connection_id FROM tenants WHERE id = $1",
      [tenantId]
    );

    if (!rows[0]?.auth0_org_id || !rows[0]?.sso_connection_id) {
      return res.status(404).json({ error: "sso_not_configured" });
    }

    await disableConnectionOnOrg(rows[0].auth0_org_id, rows[0].sso_connection_id);

    await pool.query(
      "UPDATE tenants SET sso_connection_id = NULL, sso_connection_type = NULL WHERE id = $1",
      [tenantId]
    );

    return res.json({ disabled: true });
  }
);
