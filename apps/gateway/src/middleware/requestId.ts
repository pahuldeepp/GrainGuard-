import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

declare global {
  // eslint-disable-next-line no-var
  namespace Express {
    interface Request {
      requestId?: string;
      correlationId?: string;
    }
  }
}

const VALID_REQUEST_ID = /^[a-zA-Z0-9-]{1,64}$/;

function generateId(): string {
  if (typeof (crypto as any).randomUUID === "function") {
    return (crypto as any).randomUUID() as string;
  }
  return crypto.randomBytes(16).toString("hex");
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incomingRequestId = req.header("x-request-id");
  const requestId = (incomingRequestId && VALID_REQUEST_ID.test(incomingRequestId.trim()))
    ? incomingRequestId.trim()
    : generateId();

  const incomingCorrelationId = req.header("x-correlation-id");
  const correlationId = (incomingCorrelationId && VALID_REQUEST_ID.test(incomingCorrelationId.trim()))
    ? incomingCorrelationId.trim()
    : generateId();

  req.requestId = requestId;
  req.correlationId = correlationId;

  res.setHeader("x-request-id", requestId);
  res.setHeader("x-correlation-id", correlationId);

  next();
}