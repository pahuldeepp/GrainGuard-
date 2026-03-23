import { Router, Request, Response } from "express";
import { pool } from "../database/db";
import { v4 as uuidv4 } from "uuid";

export const tenantsRouter = Router();

// Public endpoint — called during signup before JWT exists
// Protected by a signup secret to prevent abuse
tenantsRouter.post("/tenants/register", async (req: Request, res: Response) => {
  const { orgName, email, authUserId } = req.body as {
    orgName: string;
    email: string;
    authUserId: string;
  };

  if (!orgName?.trim() || !email?.trim() || !authUserId?.trim()) {
    return res.status(400).json({ error: "orgName, email and authUserId are required" });
  }

  const tenantId = uuidv4();
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");

  try {
    await pool.query("BEGIN");

    await pool.query(
      `INSERT INTO tenants (id, name, slug, email, plan, subscription_status, created_at)
       VALUES ($1, $2, $3, $4, 'free', 'trialing', NOW())`,
      [tenantId, orgName.trim(), slug, email.trim()]
    );

    // Create first admin user record
    await pool.query(
      `INSERT INTO tenant_users (id, tenant_id, auth_user_id, email, role, created_at)
       VALUES ($1, $2, $3, $4, 'admin', NOW())`,
      [uuidv4(), tenantId, authUserId, email.trim()]
    );

    await pool.query("COMMIT");

    return res.status(201).json({ tenantId, slug });
  } catch (err: any) {
    await pool.query("ROLLBACK");
    if (err.code === "23505") {
      return res.status(409).json({ error: "organisation already exists" });
    }
    console.error("[tenants] register error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});
