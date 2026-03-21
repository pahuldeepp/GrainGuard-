import { GraphQLError } from "graphql";
import type { BffContext } from "../server";

export function requireRole(ctx: BffContext, ...roles: string[]): void {
  const hasRole = roles.some(role => ctx.roles.includes(role));
  if (!hasRole) {
    throw new GraphQLError("Insufficient permissions", {
      extensions: { code: "FORBIDDEN", http: { status: 403 } },
    });
  }
}

export function requireAdmin(ctx: BffContext): void {
  requireRole(ctx, "admin");
}

export function requireOperator(ctx: BffContext): void {
  requireRole(ctx, "admin", "operator");
}