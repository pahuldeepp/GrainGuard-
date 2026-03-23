import { Pool } from "pg";

// Read replica — for SELECT queries (devices, audit, search, etc.)
export const pool = new Pool({
  connectionString:
    process.env.READ_DATABASE_URL ||
    "postgres://postgres:postgres@postgres-read:5432/grainguard_read",
});

pool.on("connect", () => {
  console.log("Postgres read DB connected");
});

// Primary write DB — for INSERT/UPDATE/DELETE (tenants, users, billing, etc.)
export const writePool = new Pool({
  connectionString:
    process.env.WRITE_DATABASE_URL ||
    `postgres://${process.env.WRITE_DB_USER ?? "postgres"}:${process.env.WRITE_DB_PASSWORD ?? "postgres"}@${process.env.WRITE_DB_HOST ?? "postgres"}:${process.env.WRITE_DB_PORT ?? "5432"}/${process.env.WRITE_DB_NAME ?? "grainguard"}`,
});

writePool.on("connect", () => {
  console.log("Postgres write DB connected");
});
