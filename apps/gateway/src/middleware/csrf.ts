import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const CSRF_SECRET = process.env.CSRF_SECRET || crypto.randomBytes(32).toString("hex");
const CSRF_HEADER = "x-csrf-token";
const CSRF_COOKIE = "_csrf";
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Safe methods that don't require CSRF validation
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Paths exempt from CSRF (webhooks from external services, not browsers)
const EXEMPT_PATHS = new Set(["/billing/webhook", "/ingest", "/graphql"]);

function generateToken(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(18).toString("hex");
  const payload = `${timestamp}.${random}`;
  const sig = crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  return `${payload}.${sig}`;
}

function validateToken(token: string): boolean {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [timestamp, random, sig] = parts;
  const payload = `${timestamp}.${random}`;
  const expectedSig = crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(payload)
    .digest("hex")
    .slice(0, 16);

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return false;
  }

  // Check token age
  const created = parseInt(timestamp, 36);
  if (isNaN(created) || Date.now() - created > TOKEN_TTL_MS) {
    return false;
  }

  return true;
}

export function csrfProtection() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Always issue a fresh token on safe methods so the SPA can read it
    if (SAFE_METHODS.has(req.method)) {
      const token = generateToken();
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: false, // JS must read this to set the header
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        maxAge: TOKEN_TTL_MS,
        path: "/",
      });
      return next();
    }

    // Skip CSRF for exempt paths (Stripe webhooks, device ingest)
    if (EXEMPT_PATHS.has(req.path)) {
      return next();
    }

    // Mutating request — validate token
    const headerToken = req.headers[CSRF_HEADER] as string | undefined;
    const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;

    // Double-submit: header must match cookie, and both must be valid
    if (!headerToken || !cookieToken) {
      return res.status(403).json({ error: "csrf_token_missing" });
    }

    if (headerToken !== cookieToken) {
      return res.status(403).json({ error: "csrf_token_mismatch" });
    }

    if (!validateToken(headerToken)) {
      return res.status(403).json({ error: "csrf_token_invalid" });
    }

    return next();
  };
}
