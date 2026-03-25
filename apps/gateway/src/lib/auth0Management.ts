// Auth0 Management API client
// Used for: creating Organizations (per-tenant SSO), creating connections,
// enabling connections on orgs, JIT provisioning on first login.
//
// Credentials come from a Machine-to-Machine application in Auth0 that has
// been granted the "Management API" audience with the following scopes:
//   create:organizations  read:organizations  update:organizations
//   create:connections    read:connections    update:connections
//   create:organization_connections
//   create:organization_invitations
//   read:users  update:users

const AUTH0_DOMAIN   = process.env.AUTH0_DOMAIN ?? "";
const M2M_CLIENT_ID  = process.env.AUTH0_MANAGEMENT_CLIENT_ID ?? "";
const M2M_CLIENT_SEC = process.env.AUTH0_MANAGEMENT_CLIENT_SECRET ?? "";

// Not validated at startup — only SSO routes call these functions.
// If the env vars are missing, calls to mgmt() will throw at request time.

const MGMT_AUDIENCE = `https://${AUTH0_DOMAIN}/api/v2/`;

// ── Token cache ───────────────────────────────────────────────────────────────
// Management API tokens expire in 86400s (24h). We cache the token and
// refresh 60s before expiry so no request ever gets a 401.
let cachedToken: string | null = null;
let tokenExpiry  = 0;

async function getManagementToken(): Promise<string> {
  if (!AUTH0_DOMAIN || !M2M_CLIENT_ID || !M2M_CLIENT_SEC) {
    throw new Error(
      "SSO not configured: AUTH0_DOMAIN, AUTH0_MANAGEMENT_CLIENT_ID, AUTH0_MANAGEMENT_CLIENT_SECRET must be set"
    );
  }

  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }

  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type:    "client_credentials",
      client_id:     M2M_CLIENT_ID,
      client_secret: M2M_CLIENT_SEC,
      audience:      MGMT_AUDIENCE,
    }),
  });

  if (!res.ok) {
    throw new Error(`Auth0 M2M token error: ${res.status} ${await res.text()}`);
  }

  const body = await res.json() as { access_token: string; expires_in: number };
  cachedToken = body.access_token;
  tokenExpiry = Date.now() + body.expires_in * 1000;
  return cachedToken;
}

// ── Generic Management API helper ────────────────────────────────────────────
async function mgmt(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const token = await getManagementToken();
  const res = await fetch(`https://${AUTH0_DOMAIN}/api/v2/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Auth0 Management API ${path}: ${res.status} ${body}`);
  }

  // 204 No Content has no body
  if (res.status === 204) return null;
  return res.json();
}

// ── User onboarding operations ────────────────────────────────────────────────

/**
 * Sets app_metadata.tenant_id on a user so the Login Action
 * injects it into every subsequent JWT automatically.
 */
export async function setUserTenantId(
  authUserId: string,
  tenantId: string
): Promise<void> {
  await mgmt(`users/${encodeURIComponent(authUserId)}`, {
    method: "PATCH",
    body: JSON.stringify({ app_metadata: { tenant_id: tenantId } }),
  });
}

/**
 * Finds the Auth0 role named `roleName` and assigns it to the user.
 * Silently no-ops if the role isn't found (don't break onboarding).
 */
export async function assignRoleByName(
  authUserId: string,
  roleName: string
): Promise<void> {
  try {
    const roles: Array<{ id: string; name: string }> = await mgmt("roles?per_page=50");
    const role = roles.find((r) => r.name === roleName);
    if (!role) {
      console.warn(`[auth0] role "${roleName}" not found — skipping assignment`);
      return;
    }
    await mgmt(`users/${encodeURIComponent(authUserId)}/roles`, {
      method: "POST",
      body: JSON.stringify({ roles: [role.id] }),
    });
  } catch (err) {
    // Non-fatal — user can still proceed without the role
    console.warn(`[auth0] assignRoleByName failed:`, err);
  }
}

// ── Organization operations ───────────────────────────────────────────────────

/**
 * Creates an Auth0 Organization for a tenant.
 * The org name must be unique — we use the tenantId to guarantee that.
 * The display_name is shown in the Auth0 Universal Login picker.
 */
export async function createOrganization(
  tenantId: string,
  displayName: string
): Promise<{ orgId: string }> {
  const org = await mgmt("organizations", {
    method: "POST",
    body: JSON.stringify({
      name:         `tenant-${tenantId}`,   // unique, URL-safe slug
      display_name: displayName,
      metadata:     { tenantId },           // lets us find the tenant from Auth0 dashboard
    }),
  });
  return { orgId: org.id };
}

/**
 * Returns the Auth0 Organization details for a tenant.
 */
export async function getOrganization(orgId: string): Promise<any> {
  return mgmt(`organizations/${orgId}`);
}

// ── Connection (SSO provider) operations ────────────────────────────────────

/**
 * Creates a SAML enterprise connection (SAML 2.0).
 * The customer configures their IdP (Okta, Azure AD, etc.) to point
 * at the ACS URL that Auth0 provides after this call.
 */
export async function createSamlConnection(opts: {
  tenantId:     string;
  name:         string;          // customer-visible label, e.g. "Acme Okta"
  signInUrl:    string;          // IdP SSO URL (Single Sign-On Service URL)
  signingCert:  string;          // Base64 PEM cert from the IdP
  emailDomains: string[];        // e.g. ["acme.com"] — required by Auth0
}): Promise<{ connectionId: string }> {
  const conn = await mgmt("connections", {
    method: "POST",
    body: JSON.stringify({
      name:           `saml-${opts.tenantId}`,
      strategy:       "samlp",
      display_name:   opts.name,
      options: {
        signInEndpoint: opts.signInUrl,
        signingCert:    opts.signingCert,
        // Map IdP attributes to Auth0 profile fields
        fieldsMap: {
          email:      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
          given_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
          family_name:"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
        },
        // JIT provisioning: create Auth0 user on first SAML login
        idpinitiated: { enabled: true, client_id: M2M_CLIENT_ID },
      },
      enabled_clients: [],        // no app clients yet — linked via org below
    }),
  });
  return { connectionId: conn.id };
}

/**
 * Creates an OIDC connection (e.g. for Azure AD, Google Workspace).
 */
export async function createOidcConnection(opts: {
  tenantId:     string;
  name:         string;
  discoveryUrl: string;          // OIDC discovery endpoint
  clientId:     string;          // registered client at the IdP
  clientSecret: string;
  emailDomains: string[];
}): Promise<{ connectionId: string }> {
  const conn = await mgmt("connections", {
    method: "POST",
    body: JSON.stringify({
      name:         `oidc-${opts.tenantId}`,
      strategy:     "oidc",
      display_name: opts.name,
      options: {
        type:         "back_channel",
        discovery_url:opts.discoveryUrl,
        client_id:    opts.clientId,
        client_secret:opts.clientSecret,
        scope:        "openid profile email",
      },
      enabled_clients: [],
    }),
  });
  return { connectionId: conn.id };
}

/**
 * Enables a connection on an Auth0 Organization.
 * After this, users whose email domain matches will see the IdP login.
 * assign_membership_on_login: true → user is auto-added to the org.
 */
export async function enableConnectionOnOrg(
  orgId:        string,
  connectionId: string
): Promise<void> {
  await mgmt(`organizations/${orgId}/enabled_connections`, {
    method: "POST",
    body: JSON.stringify({
      connection_id:                connectionId,
      assign_membership_on_login:   true,   // JIT provisioning
    }),
  });
}

/**
 * Removes an SSO connection from an organization.
 * The connection itself is NOT deleted — just unlinked from this org.
 */
export async function disableConnectionOnOrg(
  orgId:        string,
  connectionId: string
): Promise<void> {
  await mgmt(`organizations/${orgId}/enabled_connections/${connectionId}`, {
    method: "DELETE",
  });
}

/**
 * Lists all connections enabled on an organization.
 */
export async function listOrgConnections(orgId: string): Promise<any[]> {
  return mgmt(`organizations/${orgId}/enabled_connections`);
}

/**
 * Sends an Auth0 Organization invitation email.
 * The recipient clicks the link → Auth0 shows the org-specific login.
 */
export async function inviteToOrg(opts: {
  orgId:     string;
  email:     string;
  role:      string;
  inviterName: string;
}): Promise<void> {
  await mgmt(`organizations/${opts.orgId}/invitations`, {
    method: "POST",
    body: JSON.stringify({
      inviter: { name: opts.inviterName },
      invitee: { email: opts.email },
      client_id:   M2M_CLIENT_ID,
      roles:       [opts.role],
      send_invitation_email: true,
    }),
  });
}
