import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const CSRF_HEADER = "x-csrf-token";
const CSRF_COOKIE = "__Host-csrf";
const TOKEN_BYTES = 32;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Cookie flags: __Host- prefix forces Secure + no Domain + Path=/
// which is the strongest CSRF protection available in browsers
function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,   // JS must read it to send in header
    secure: true,
    sameSite: "strict",
    path: "/",
  });
}

export function csrfProtection() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Issue a token on GET if not present
    if (SAFE_METHODS.has(req.method)) {
      if (!req.cookies?.[CSRF_COOKIE]) {
        setCsrfCookie(res, generateToken());
      }
      return next();
    }

    // Enforce on state-mutating methods
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER] as string | undefined;

    if (!cookieToken || !headerToken) {
      res.status(403).json({ error: "csrf_missing", message: "CSRF token required" });
      return;
    }

    // Constant-time comparison to prevent timing attacks
    const cookieBuf = Buffer.from(cookieToken, "hex");
    const headerBuf = Buffer.from(headerToken, "hex");

    if (
      cookieBuf.length !== headerBuf.length ||
      !crypto.timingSafeEqual(cookieBuf, headerBuf)
    ) {
      res.status(403).json({ error: "csrf_invalid", message: "CSRF token mismatch" });
      return;
    }

    // Rotate token after each mutating request
    const newToken = generateToken();
    setCsrfCookie(res, newToken);
    next();
  };
}
