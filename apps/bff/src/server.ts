import crypto from "crypto";
import { ApolloServer } from "@apollo/server";
import depthLimit from "graphql-depth-limit";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "http";
import cors from "cors";
import { metricsHandler } from "./observability/metrics";
import helmet from "helmet";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { GraphQLError } from "graphql";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import { startTelemetryWatcher } from "./telemetryWatcher";
import { postgresCircuitBreaker } from "./lib/circuitBreaker";

const JWKS_URL = process.env.JWKS_URL!;
const ISSUER = process.env.JWT_ISSUER!;
const AUDIENCE = process.env.JWT_AUDIENCE!;
const ALLOWED_ORIGINS =
  (process.env.ALLOWED_ORIGINS ||
    "http://localhost:5173,http://localhost:5174,http://localhost:8086").split(",");
if (!JWKS_URL || !ISSUER || !AUDIENCE) {
  throw new Error("JWKS_URL, JWT_ISSUER, JWT_AUDIENCE must be set");
}

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return payload as JWTPayload & {
    "https://grainguard/tenant_id"?: string;
    sub?: string;
    roles?: string[];
  };
}

export interface BffContext {
  tenantId:  string;
  userId:    string;
  roles:     string[];
  isSuperAdmin: boolean;
  requestId: string;
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: [
          "'self'",
          "http://localhost:4000",
          "ws://localhost:4000",
          "http://localhost:8086",
          "ws://localhost:8086",
        ],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  const schema = makeExecutableSchema({ typeDefs, resolvers });

  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  const serverCleanup = useServer(
    {
      schema,
      context: async (ctx: Record<string, any>) => {
        const token = ctx.connectionParams?.authorization as string | undefined;
        if (!token?.startsWith("Bearer ")) throw new Error("Missing token");
        const payload = await verifyToken(token.substring("Bearer ".length));
        const tenantId = payload["https://grainguard/tenant_id"];
        if (!tenantId) throw new Error("Tenant not found");
        const roles = Array.isArray(payload.roles) ? payload.roles : [];
        return {
          tenantId: String(tenantId),
          userId: String(payload.sub || ""),
          roles,
          isSuperAdmin: roles.includes("superadmin"),
        };
      },
    },
    wsServer
  );

  const server = new ApolloServer<BffContext>({
    validationRules: [
      depthLimit(5),  // max query depth = 5 levels
    ],
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
    ],
    introspection: process.env.NODE_ENV !== "production",
  });

  await server.start();

  app.get("/metrics", metricsHandler());

  app.use(
    "/graphql",
    cors<cors.CorsRequest>({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: origin ${origin} not allowed`));
      },
      credentials: true,
    }),
    express.json({ limit: "10kb" }),
    expressMiddleware(server, {
      context: async ({ req }): Promise<BffContext> => {
        const requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();

        // Dev bypass — AUTH_ENABLED=false skips JWT validation (non-production only)
        if (process.env.AUTH_ENABLED === "false" && process.env.NODE_ENV !== "production") {
          const tenantId =
            (req.headers["x-tenant-id"] as string) ||
            "11111111-1111-1111-1111-111111111111";
          return { tenantId, userId: "dev-user", roles: ["admin", "member", "superadmin"], isSuperAdmin: true, requestId };
        }

        const authHeader = req.headers.authorization;

        if (!authHeader?.startsWith("Bearer ")) {
          throw new GraphQLError("Missing authentication token", {
            extensions: { code: "UNAUTHENTICATED", http: { status: 401 } },
          });
        }

        const token = authHeader.substring("Bearer ".length);

        try {
          const payload = await verifyToken(token);
          // Auth0 Action injects claims under https://grainguard.com/ namespace
          const NS = "https://grainguard.com";
          const tenantId =
            (payload as any)[`${NS}/tenant_id`] ??
            (payload as any)["https://grainguard/tenant_id"];
          const rawRoles =
            (payload as any)[`${NS}/roles`] ??
            (payload as any)["https://grainguard/roles"] ??
            (payload as any).roles;
          const userId = payload.sub;

          if (!tenantId) {
            throw new GraphQLError("Tenant not found in token", {
              extensions: { code: "FORBIDDEN", http: { status: 403 } },
            });
          }

          // Guard against non-UUID tenant_id values (e.g. legacy "tenant_001")
          // to prevent Postgres syntax errors that trip the circuit breaker.
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!UUID_RE.test(String(tenantId))) {
            throw new GraphQLError(
              "Invalid tenant ID format in token — please sign out and sign back in.",
              { extensions: { code: "FORBIDDEN", http: { status: 403 } } }
            );
          }

          const roles = Array.isArray(rawRoles) ? rawRoles.map(String) : [];
          return {
            tenantId:    String(tenantId),
            userId:      String(userId || ""),
            roles,
            isSuperAdmin: roles.includes("superadmin"),
            requestId,
          };
        } catch (err) {
          if (err instanceof GraphQLError) throw err;
          throw new GraphQLError("Invalid or expired token", {
            extensions: { code: "UNAUTHENTICATED", http: { status: 401 } },
          });
        }
      },
    })
  );

  const PORT = parseInt(process.env.PORT || "4000");

  // Centralized error handler — must be registered after all routes
  app.use((err: Error, req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) ?? "unknown";
    console.error({ requestId, error: err.message, stack: err.stack });
    if (res.headersSent) return next(err);
    res.status(500).json({
      error: "internal_server_error",
      message: err.message,
      requestId,
    });
  });

  await new Promise<void>((resolve) => httpServer.listen({ port: PORT }, resolve));

  await startTelemetryWatcher();

  console.log(JSON.stringify({
    level: "info",
    service: "bff",
    message: `BFF GraphQL server running at http://localhost:${PORT}/graphql`,
    websocket: `ws://localhost:${PORT}/graphql`,
    allowedOrigins: ALLOWED_ORIGINS,
  }));
}

startServer().catch((err) => {
  console.error("Failed to start BFF:", err);
  process.exit(1);
});
