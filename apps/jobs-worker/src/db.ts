import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://grainguard:grainguard@postgres:5432/grainguard";

export const db = new Pool({ connectionString: DATABASE_URL, max: 5 });
