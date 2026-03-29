import { Pool } from "pg";

function shouldUseTls(connectionString: string | undefined): boolean {
  if (!connectionString) return false;
  return /sslmode=(require|verify-ca|verify-full)/i.test(connectionString);
}

function buildPoolConfig(connectionString: string | undefined, envVar: string) {
  const rejectUnauthorized = process.env[envVar] !== "false";

  return {
    connectionString,
    ...(shouldUseTls(connectionString)
      ? {
          ssl: {
            rejectUnauthorized,
          },
        }
      : {}),
  };
}

function buildWriteConnectionString(): string {
  if (process.env.WRITE_DATABASE_URL) {
    return process.env.WRITE_DATABASE_URL;
  }

  if (process.env.WRITE_DB_URL) {
    return process.env.WRITE_DB_URL;
  }

  const host = process.env.WRITE_DB_HOST || "postgres";
  const port = process.env.WRITE_DB_PORT || "5432";
  const name = process.env.WRITE_DB_NAME || "grainguard";
  const user = process.env.WRITE_DB_USER || "postgres";
  const password = process.env.WRITE_DB_PASSWORD || "postgres";

  return `postgres://${user}:${password}@${host}:${port}/${name}?sslmode=disable`;
}

export const pool = new Pool({
  ...buildPoolConfig(
    process.env.READ_DATABASE_URL ||
      "postgres://postgres:postgres@postgres-read:5432/grainguard_read",
    "READ_DB_SSL_REJECT_UNAUTHORIZED"
  ),
});

export const writePool = new Pool({
  ...buildPoolConfig(
    buildWriteConnectionString(),
    "WRITE_DB_SSL_REJECT_UNAUTHORIZED"
  ),
});

pool.on("connect", () => {
  console.log("Postgres read DB connected");
});

writePool.on("connect", () => {
  console.log("Postgres write DB connected");
});
