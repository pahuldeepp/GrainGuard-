import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS_URL = process.env.JWKS_URL!;
const ISSUER = process.env.JWT_ISSUER!;
const AUDIENCE = process.env.JWT_AUDIENCE!;

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return payload;
}
