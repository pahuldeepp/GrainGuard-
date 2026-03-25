import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { writePool as pool } from "../lib/db";
import { authMiddleware } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";

export const billingRouter = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-02-25.clover",
  timeout: 15_000,       // 15s timeout on all Stripe API calls
  maxNetworkRetries: 2,  // auto-retry on network errors
});

const GATEWAY_URL  = process.env.GATEWAY_URL  || "http://localhost:3000";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://localhost:5173";

const PRICE_IDS: Record<string, string> = {
  starter:      process.env.STRIPE_PRICE_STARTER       || "",
  professional: process.env.STRIPE_PRICE_PROFESSIONAL  || "",
};

// ── GET /billing/subscription ─────────────────────────────────────────────
billingRouter.get(
  "/billing/subscription",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT stripe_customer_id, stripe_subscription_id, plan, status, trial_ends_at
       FROM tenant_billing
       WHERE tenant_id = $1`,
      [req.user!.tenantId]
    );

    if (rows.length === 0) {
      return res.json({ plan: "free", status: "none" });
    }

    const billing = rows[0];

    // Fetch live subscription data from Stripe to get real period end
    let currentPeriodEnd: number | null = null;
    let cancelAtPeriodEnd = false;
    let paymentFailed = false;

    if (billing.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(
          billing.stripe_subscription_id
        );
        currentPeriodEnd  = (sub as any).current_period_end;     // Unix timestamp
        cancelAtPeriodEnd = sub.cancel_at_period_end;
        paymentFailed     = sub.status === "past_due" || sub.status === "unpaid";
      } catch (err) {
        console.error("[billing] stripe subscription fetch failed:", err);
      }
    }

    return res.json({
      plan:             billing.plan,
      status:           billing.status,
      trialEndsAt:      billing.trial_ends_at ?? null,
      currentPeriodEnd: currentPeriodEnd,
      cancelAtPeriodEnd,
      paymentFailed,
    });
  }
);

// ── POST /billing/checkout ────────────────────────────────────────────────
billingRouter.post(
  "/billing/checkout",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { plan } = req.body as { plan: string };

    const priceId = PRICE_IDS[plan];
    if (!priceId) {
      return res.status(400).json({ error: "invalid_plan" });
    }

    // Get or create Stripe customer
    const { rows } = await pool.query(
      `SELECT stripe_customer_id FROM tenant_billing WHERE tenant_id = $1`,
      [req.user!.tenantId]
    );

    let customerId: string | undefined = rows[0]?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { tenantId: req.user!.tenantId },
      });
      customerId = customer.id;

      await pool.query(
        `INSERT INTO tenant_billing (tenant_id, stripe_customer_id, plan, status, created_at)
         VALUES ($1, $2, 'free', 'none', NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id = $2`,
        [req.user!.tenantId, customerId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${DASHBOARD_URL}/billing?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${DASHBOARD_URL}/billing?cancelled=1`,
      metadata: {
        tenantId: req.user!.tenantId,
        plan,
      },
    });

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "billing.checkout_started",
      resourceType: "billing",
      meta:         { plan, sessionId: session.id },
      ipAddress:    req.ip,
    });

    return res.json({ url: session.url });
  }
);

// ── POST /billing/portal ──────────────────────────────────────────────────
billingRouter.post(
  "/billing/portal",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT stripe_customer_id FROM tenant_billing WHERE tenant_id = $1`,
      [req.user!.tenantId]
    );

    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) {
      return res.status(404).json({ error: "no_billing_record" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${DASHBOARD_URL}/billing`,
    });

    await writeAuditLog({
      tenantId:     req.user!.tenantId,
      actorId:      req.user!.sub,
      eventType:    "billing.portal_accessed",
      resourceType: "billing",
      ipAddress:    req.ip,
    });

    return res.json({ url: session.url });
  }
);

// ── POST /billing/webhook ─────────────────────────────────────────────────
billingRouter.post(
  "/billing/webhook",
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"] as string;

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,                              // raw body — must use express.raw()
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err: any) {
      console.error("[billing] webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session  = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.metadata?.tenantId;
        const plan     = session.metadata?.plan;
        if (tenantId && plan && session.subscription) {
          await pool.query(
            `UPDATE tenant_billing
             SET stripe_subscription_id = $1, plan = $2, status = 'active', updated_at = NOW()
             WHERE tenant_id = $3`,
            [session.subscription, plan, tenantId]
          );
          await writeAuditLog({
            tenantId,
            actorId:      "stripe",
            eventType:    "billing.subscription_created",
            resourceType: "billing",
            resourceId:   String(session.subscription),
            meta:         { plan },
          });
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub      = event.data.object as Stripe.Subscription;
        const tenantId = sub.metadata?.tenantId;
        if (tenantId) {
          const plan = sub.items.data[0]?.price.metadata?.plan ?? "unknown";
          await pool.query(
            `UPDATE tenant_billing
             SET status = $1, plan = $2, updated_at = NOW()
             WHERE stripe_subscription_id = $3`,
            [sub.status, plan, sub.id]
          );
          await writeAuditLog({
            tenantId,
            actorId:      "stripe",
            eventType:    "billing.subscription_updated",
            resourceId:   sub.id,
            resourceType: "billing",
            meta:         { status: sub.status, plan },
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await pool.query(
          `UPDATE tenant_billing
           SET status = 'cancelled', plan = 'free', updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        break;
      }
    }

    return res.json({ received: true });
  }
);