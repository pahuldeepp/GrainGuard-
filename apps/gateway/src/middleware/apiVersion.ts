import { Request, Response, NextFunction } from "express";

// Supported API versions — oldest to newest
export const SUPPORTED_VERSIONS = [
  "2024-01-01",
  "2024-06-01",
  "2025-01-01",
] as const;

export type ApiVersion = typeof SUPPORTED_VERSIONS[number];

// Default version — what clients get if they don't send a header
export const DEFAULT_VERSION: ApiVersion = "2025-01-01";

// Versions that are deprecated but still supported
export const DEPRECATED_VERSIONS: ApiVersion[] = ["2024-01-01"];

// Sunset dates — when deprecated versions will stop working
export const SUNSET_DATES: Partial<Record<ApiVersion, string>> = {
  "2024-01-01": "2025-06-01",
  "2024-06-01": "2026-01-01",
};

function isSupported(version: string): version is ApiVersion {
  return SUPPORTED_VERSIONS.includes(version as ApiVersion);
}

export function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestedVersion = req.headers["api-version"] as string | undefined;

  // No header — use default version
  const version = requestedVersion || DEFAULT_VERSION;

  // Validate version
  if (!isSupported(version)) {
    res.status(400).json({
      error: "Unsupported API version",
      requested: version,
      supported: SUPPORTED_VERSIONS,
      default: DEFAULT_VERSION,
      requestId: req.requestId,
    });
    return;
  }

  // Attach version to request for downstream use
  req.apiVersion = version;

  // Always echo back version used
  res.setHeader("API-Version", version);

  // Warn about deprecated versions
  if (DEPRECATED_VERSIONS.includes(version)) {
    res.setHeader("Deprecation", "true");
    res.setHeader("X-API-Deprecated", "true");

    const sunset = SUNSET_DATES[version];
    if (sunset) {
      res.setHeader("Sunset", sunset);
      res.setHeader("X-API-Sunset", sunset);
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        service: "gateway",
        message: "deprecated API version used",
        version,
        sunset,
        path: req.path,
        requestId: req.requestId,
      })
    );
  }

  next();
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      apiVersion: ApiVersion;
    }
  }
}

