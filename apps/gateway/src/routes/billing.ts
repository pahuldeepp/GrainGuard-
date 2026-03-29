import { Router, Request, Response } from "express";
import Stripe from "stripe";
import amqp from "amqplib";
import { writePool as pool } from "../lib/db";
import { authMiddleware } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { apiRateLimiter } from "../middleware/rateLimiting";

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://grainguard:grainguard@rabbitmq:5672/grainguard";
const STRIPE_BILLING_QUEUE = "grainguard.stripe.billing";

async function publishToStripeQueue(payload: object): Promise<void> {
  let conn: Awaited<ReturnType<typeof amqp.connect>> | null = null;
  let ch: amqp.ConfirmChannel | null = null;
  try {
    conn = await amqp.connect(RABBITMQ_URL);
    ch = await conn.createConfirmChannel();
    await ch.assertQueue(STRIPE_BILLING_QUEUE, { durable: true });
    ch.sendToQueue(
      STRIPE_BILLING_QUEUE,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true }
    );
    await ch.waitForConfirms();
  } finally {
    await ch?.close().catch(() => {});
    conn?.close().catch(() => {});
  }
}

export const billingRouter = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-02-25.clover",
  timeout: 15_000,       // 15s timeout on all Stripe API calls
  maxNetworkRetries: 2,  // auto-retry on network errors
});

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://localhost:5173";

const PRICE_IDS: Record<string, string> = {
  starter:      process.env.STRIPE_PRICE_STARTER       || "",
  professional: process.env.STRIPE_PRICE_PROFESSIONAL  || "",
};

function parseCurrentPeriodEnd(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Math.floor(value.getTime() / 1000);
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return Math.floor(parsed.getTime() / 1000);
    }
  }
  return null;
}

// ── GET /billing/subscription ─────────────────────────────────────────────
billingRouter.get(
  "/billing/subscription",
  authMiddleware,
  apiRateLimiter,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT tb.stripe_customer_id,
              tb.stripe_subscription_id,
              tb.plan,
              tb.status,
              tb.trial_ends_at,
              t.current_period_end
         FROM tenant_billing tb
         JOIN tenants t ON t.id = tb.tenant_id
        WHERE tb.tenant_id = $1`,
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
        currentPeriodEnd  = parseCurrentPeriodEnd(
          (sub as unknown as { current_period_end?: number }).current_period_end
        );
        cancelAtPeriodEnd = sub.cancel_at_period_end;
        paymentFailed     = sub.status === "past_due" || sub.status === "unpaid";
      } catch (err) {
        console.error("[billing] stripe subscription fetch failed:", err);
      }
    }

    if (currentPeriodEnd == null) {
      currentPeriodEnd = parseCurrentPeriodEnd(billing.current_period_end);
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
  apiRateLimiter,
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
         ON CONFLICT (tenant_id) DO UPDATE
           SET stripe_customer_id = $2,
               updated_at = NOW()`,
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
      subscription_data: {
        metadata: {
          tenantId: req.user!.tenantId,
          plan,
        },
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
  apiRateLimiter,
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

export async function stripeWebhookHandler(req: Request, res: Response) {
  const sig = req.headers["stripe-signature"] as string;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("[billing] webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await publishToStripeQueue({
      stripeEventId: event.id,
      stripeEventType: event.type,
      payload: event.data.object,
    });
    console.log(`[billing] queued stripe event ${event.type} id=${event.id}`);
    return res.json({ received: true });
  } catch (err) {
    console.error("[billing] failed to queue stripe event:", err);
    return res.status(500).json({ error: "queue_publish_failed" });
  }
}
