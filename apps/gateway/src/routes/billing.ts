import { Router, Request, Response } from "express";
import { stripe, PLANS, PlanKey } from "../services/stripe";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../database/db";
import { invalidatePlanCache } from "../middleware/planEnforcement";

export const billingRouter = Router();

// ── Create Stripe checkout session ────────────────────────────────────────────
billingRouter.post(
  "/billing/checkout",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { plan } = req.body as { plan: PlanKey };
    const tenantId = req.user!.tenantId;

    if (!PLANS[plan]) {
      return res.status(400).json({ error: "invalid_plan" });
    }

    // Get or create Stripe customer for this tenant
    const tenantRow = await pool.query(
      "SELECT stripe_customer_id, email FROM tenants WHERE id = $1",
      [tenantId]
    );

    if (tenantRow.rows.length === 0) {
      return res.status(404).json({ error: "tenant_not_found" });
    }

    let customerId: string = tenantRow.rows[0].stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: tenantRow.rows[0].email,
        metadata: { tenantId },
      });
      customerId = customer.id;
      await pool.query(
        "UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2",
        [customerId, tenantId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: PLANS[plan].priceId, quantity: 1 }],
      success_url: `${process.env.DASHBOARD_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.DASHBOARD_URL}/billing`,
      metadata: { tenantId, plan },
    });

    return res.json({ url: session.url });
  }
);

// ── Get current subscription ──────────────────────────────────────────────────
billingRouter.get(
  "/billing/subscription",
  authMiddleware,
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const row = await pool.query(
      `SELECT plan, stripe_subscription_id, subscription_status,
              trial_ends_at, current_period_end
       FROM tenants WHERE id = $1`,
      [tenantId]
    );

    if (row.rows.length === 0) {
      return res.status(404).json({ error: "tenant_not_found" });
    }

    return res.json(row.rows[0]);
  }
);

// ── Stripe webhook ────────────────────────────────────────────────────────────
billingRouter.post(
  "/billing/webhook",
  // Raw body needed for Stripe signature verification
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"] as string;

    if (!sig) {
      return res.status(400).json({ error: "missing_stripe_signature" });
    }

    // req.body MUST be a Buffer (raw) for Stripe HMAC verification.
    // The express.raw() middleware in server.ts ensures this for /billing/webhook.
    if (!Buffer.isBuffer(req.body)) {
      console.error("[billing] webhook body is not a Buffer — express.raw() middleware may be missing");
      return res.status(500).json({ error: "webhook_configuration_error" });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err) {
      return res.status(400).json({ error: "webhook_signature_invalid" });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as any;
        const { tenantId, plan } = session.metadata;
        await pool.query(
          `UPDATE tenants
           SET plan = $1,
               stripe_subscription_id = $2,
               subscription_status = 'active',
               current_period_end = to_timestamp($3)
           WHERE id = $4`,
          [plan, session.subscription, session.expires_at, tenantId]
        );
        await invalidatePlanCache(tenantId);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as any;
        const tenantRow = await pool.query(
          "SELECT id FROM tenants WHERE stripe_subscription_id = $1",
          [sub.id]
        );
        if (tenantRow.rows.length > 0) {
          await pool.query(
            `UPDATE tenants
             SET subscription_status = $1,
                 current_period_end = to_timestamp($2)
             WHERE id = $3`,
            [sub.status, sub.current_period_end, tenantRow.rows[0].id]
          );
          await invalidatePlanCache(tenantRow.rows[0].id);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as any;
        const delTenant = await pool.query(
          "SELECT id FROM tenants WHERE stripe_subscription_id = $1",
          [sub.id]
        );
        await pool.query(
          `UPDATE tenants
           SET plan = 'free', subscription_status = 'canceled'
           WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        if (delTenant.rows.length > 0) {
          await invalidatePlanCache(delTenant.rows[0].id);
        }
        break;
      }
    }

    return res.json({ received: true });
  }
);
