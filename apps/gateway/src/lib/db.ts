// Re-export from the canonical database module so that route files that
// import { pool } from "../lib/db" resolve correctly.
export { pool, writePool } from "../database/db";
