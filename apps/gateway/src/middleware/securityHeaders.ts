import helmet from "helmet";
import { RequestHandler } from "express";

// Strict CSP for the GrainGuard API gateway.
// No inline scripts, no eval, no external resources.
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'"],
        styleSrc:       ["'self'"],
        imgSrc:         ["'self'", "data:"],
        connectSrc:     ["'self'"],
        fontSrc:        ["'self'"],
        objectSrc:      ["'none'"],
        mediaSrc:       ["'none'"],
        frameSrc:       ["'none'"],
        frameAncestors: ["'none'"],
        formAction:     ["'self'"],
        baseUri:        ["'self'"],
        upgradeInsecureRequests: [],
      },
    },

    // Prevent clickjacking
    frameguard: { action: "deny" },

    // Force HTTPS for 1 year, include subdomains
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },

    // Disable browser MIME sniffing
    noSniff: true,

    // Disable X-Powered-By header
    hidePoweredBy: true,

    // Referrer policy — don't leak URL to third parties
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },

    // Permissions policy — disable unused browser APIs
    permittedCrossDomainPolicies: { permittedPolicies: "none" },

    crossOriginEmbedderPolicy: false, // keep false — WebSocket support
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
  });
}

// Permissions-Policy header (not in helmet by default)
export function permissionsPolicy(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      [
        "camera=()",
        "microphone=()",
        "geolocation=()",
        "payment=()",
        "usb=()",
        "magnetometer=()",
        "accelerometer=()",
        "gyroscope=()",
      ].join(", ")
    );
    next();
  };
}
