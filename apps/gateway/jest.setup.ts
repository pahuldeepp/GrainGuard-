// Set required env vars before any module is imported.
// AUTH_ENABLED=false + NODE_ENV=test → auth middleware uses the dev bypass.
process.env.JWKS_URL   = "https://test.auth0.com/.well-known/jwks.json";
process.env.JWT_ISSUER  = "https://test.auth0.com/";
process.env.JWT_AUDIENCE = "https://api.test.grainguard.com";
process.env.NODE_ENV    = "test";
process.env.AUTH_ENABLED = "false";
