// review-sweep
import { z } from "zod";
import { Request, Response, NextFunction } from "express";

// ── Schemas ──────────────────────────────────────────────────────────

export const createDeviceSchema = z.object({
  serialNumber: z
    .string({ required_error: "serialNumber is required" })
    .min(1, "serialNumber must not be empty")
    .max(100, "serialNumber must be under 100 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "serialNumber must be alphanumeric"),
});

export const deviceIdParamSchema = z.object({
  deviceId: z
    .string({ required_error: "deviceId is required" })
    .uuid("deviceId must be a valid UUID"),
});

// ── Middleware factory ────────────────────────────────────────────────

type SchemaTarget = "body" | "params" | "query";

export function validate(schema: z.ZodSchema, target: SchemaTarget = "body") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
        code: e.code,
      }));

      res.status(400).json({
        error: "Validation failed",
        errors,
        requestId: req.requestId,
      });
      return;
    }

    // Replace req[target] with parsed + coerced data
    (req as any)[target] = result.data;
    next();
  };
}
