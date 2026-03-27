import { Pool } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.READ_DATABASE_URL ||
    "postgres://postgres:postgres@postgres-read:5432/grainguard_read",
});

pool.on("connect", () => {
  console.log("Postgres read DB connected");
});
