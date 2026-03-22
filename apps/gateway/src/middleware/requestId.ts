import { Request, Response, NextFunction } from "express";
import crypto from "crypto";


declare global {
  // eslint-disable-next-line no-var
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

// Allow UUID format or alphanumeric+hyphens up to 64 chars (prevents log injection)
const VALID_REQUEST_ID = /^[a-zA-Z0-9-]{1,64}$/;

function generateRequestId(): string {
  if (typeof (crypto as any).randomUUID === "function") {
    return (crypto as any).randomUUID() as string;
  }
  return crypto.randomBytes(16).toString("hex");
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");

  let requestId: string;
  if (incoming && VALID_REQUEST_ID.test(incoming.trim())) {
    requestId = incoming.trim();
  } else {
    requestId = generateRequestId();
  }

  req.requestId = requestId;

  // Echo back for client correlation and debugging
  res.setHeader("x-request-id", requestId);

  next();
}

