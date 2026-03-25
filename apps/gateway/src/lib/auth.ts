// Re-export from the canonical middleware module so that route files that
// import { authMiddleware } from "../lib/auth" resolve correctly.
export { authMiddleware } from "../middleware/auth";
