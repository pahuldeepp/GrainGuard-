import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { GraphQLError } from "graphql";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";

const JWKS_URL = process.env.JWKS_URL!;
const ISSUER = process.env.JWT_ISSUER!;
const AUDIENCE = process.env.JWT_AUDIENCE!;

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

const server = new ApolloServer<BffContext>({
  typeDefs,
  resolvers,
});

const PORT = parseInt(process.env.PORT || "4000");

startStandaloneServer(server, {
  listen: { port: PORT },
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
}).then(({ url }) => {
  console.log(`BFF GraphQL server running at ${url}`);
});
