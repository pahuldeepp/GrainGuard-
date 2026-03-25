import { Pool } from "pg";

if (!process.env.READ_DATABASE_URL && process.env.NODE_ENV === "production") {
  throw new Error("READ_DATABASE_URL is required in production");
}
if (!process.env.WRITE_DATABASE_URL && !process.env.WRITE_DB_HOST && process.env.NODE_ENV === "production") {
  throw new Error("WRITE_DATABASE_URL or WRITE_DB_HOST is required in production");
}

// Read replica — for SELECT queries (devices, audit, search, etc.)
export const pool = new Pool({
  connectionString:
    process.env.READ_DATABASE_URL ||
    `postgres://${process.env.READ_DB_USER ?? "postgres"}:${process.env.READ_DB_PASSWORD ?? "postgres"}@${process.env.READ_DB_HOST ?? "postgres-read"}:${process.env.READ_DB_PORT ?? "5432"}/${process.env.READ_DB_NAME ?? "grainguard_read"}`,
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("connect", () => {
  console.log("Postgres read DB connected");
});

pool.on("error", (err) => {
  console.error("Postgres read pool error:", err);
});

// Primary write DB — for INSERT/UPDATE/DELETE (tenants, users, billing, etc.)
export const writePool = new Pool({
  connectionString:
    process.env.WRITE_DATABASE_URL ||
    `postgres://${process.env.WRITE_DB_USER ?? "postgres"}:${process.env.WRITE_DB_PASSWORD ?? "postgres"}@${process.env.WRITE_DB_HOST ?? "postgres"}:${process.env.WRITE_DB_PORT ?? "5432"}/${process.env.WRITE_DB_NAME ?? "grainguard"}`,
  max: 10,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

writePool.on("connect", () => {
  console.log("Postgres write DB connected");
});

writePool.on("error", (err) => {
  console.error("Postgres write pool error:", err);
});
