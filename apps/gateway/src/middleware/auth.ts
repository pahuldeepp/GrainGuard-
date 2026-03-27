import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";

/* =========================================
   🔐 Environment Config (OAuth Provider)
========================================= */

const JWKS_URL = process.env.JWKS_URL!;
const ISSUER = process.env.JWT_ISSUER!;
const AUDIENCE = process.env.JWT_AUDIENCE!;

if (!JWKS_URL || !ISSUER || !AUDIENCE) {
  throw new Error(
    "JWKS_URL, JWT_ISSUER, JWT_AUDIENCE must be defined"
  );
}

/* =========================================
   🌍 JWKS Remote Key Set
========================================= */

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

/* =========================================
   🧠 Extend Express Request
========================================= */

declare global {
  namespace Express {
    interface Request {
      user?: {
        sub: string;
        tenantId: string;
        roles?: string[];
        scopes?: string[];
      };
    }
  }
}

/* =========================================
   🚀 Auth Middleware (RS256)
========================================= */

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token" });
  }

  const token = authHeader.substring("Bearer ".length);

  try {
    // ✅ Verify signature via JWKS (RS256)
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    const claims = payload as JWTPayload & {
      tenant_id?: string;
      roles?: string[];
      scope?: string;
    };

    const tenantId =
      claims.tenant_id ||
      (claims as any)["https://grainguard/tenant_id"];

    if (!tenantId) {
      return res.status(403).json({ error: "tenant_missing" });
    }

    req.user = {
      sub: String(claims.sub || ""),
      tenantId: String(tenantId),
      roles: Array.isArray(claims.roles)
        ? claims.roles.map(String)
        : undefined,
      scopes:
        typeof claims.scope === "string"
          ? claims.scope.split(" ")
          : undefined,
    };

    return next();
  } catch (err) {
    return res.status(401).json({ error: "invalid_token" });
  }
}
