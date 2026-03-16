import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import { makeExecutableSchema } from "@graphql-tools/utils";
import { GraphQLError } from "graphql";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import { startTelemetryWatcher } from "./telemetryWatcher";

const JWKS_URL = process.env.JWKS_URL!;
const ISSUER = process.env.JWT_ISSUER!;
const AUDIENCE = process.env.JWT_AUDIENCE!;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:5174").split(",");

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
  };
}

export interface BffContext {
  tenantId: string;
  userId: string;
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
        connectSrc: ["'self'", "ws://localhost:4000", "wss://localhost:4000"],
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
      context: async (ctx) => {
        const token = ctx.connectionParams?.authorization as string | undefined;
        if (!token?.startsWith("Bearer ")) throw new Error("Missing token");
        const payload = await verifyToken(token.substring("Bearer ".length));
        const tenantId = payload["https://grainguard/tenant_id"];
        if (!tenantId) throw new Error("Tenant not found");
        return { tenantId: String(tenantId), userId: String(payload.sub || "") };
      },
    },
    wsServer
  );

  const server = new ApolloServer<BffContext>({
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
        const authHeader = req.headers.authorization;

        if (!authHeader?.startsWith("Bearer ")) {
          throw new GraphQLError("Missing authentication token", {
            extensions: { code: "UNAUTHENTICATED", http: { status: 401 } },
          });
        }

        const token = authHeader.substring("Bearer ".length);

        try {
          const payload = await verifyToken(token);
          const tenantId = payload["https://grainguard/tenant_id"];
          const userId = payload.sub;

          if (!tenantId) {
            throw new GraphQLError("Tenant not found in token", {
              extensions: { code: "FORBIDDEN", http: { status: 403 } },
            });
          }

          return {
            tenantId: String(tenantId),
            userId: String(userId || ""),
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
