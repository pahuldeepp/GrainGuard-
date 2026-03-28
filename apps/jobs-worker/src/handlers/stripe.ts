import { Channel } from "amqplib";
import { PoolClient } from "pg";

import { db } from "../db";
import { EmailJob, QUEUES, StripeWebhookJob } from "../queues";

const MAX_RETRIES = 3;
const FREE_DEVICE_LIMIT = 5;

interface BillingContext {
  tenantId: string;
  email?: string | null;
  plan: string;
  status: string;
  currentPeriodEnd: Date | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}

function queueEmail(channel: Channel, job: EmailJob): void {
  channel.sendToQueue(QUEUES.EMAILS, Buffer.from(JSON.stringify(job)), {
    persistent: true,
  });
}

function normalizePlan(plan: unknown, fallback = "free"): string {
  return typeof plan === "string" && plan.length > 0 ? plan : fallback;
}

function toDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function hasPaidAccess(status: string, currentPeriodEnd: Date | null): boolean {
  if (status === "active" || status === "trialing") {
    return true;
  }

  return (
    (status === "past_due" || status === "cancelled") &&
    currentPeriodEnd != null &&
    currentPeriodEnd.getTime() > Date.now()
  );
}

function planDeviceLimit(
  plan: string,
  status: string,
  currentPeriodEnd: Date | null,
): number {
  if (!hasPaidAccess(status, currentPeriodEnd)) {
    return FREE_DEVICE_LIMIT;
  }

  switch (plan) {
    case "enterprise":
      return -1;
    case "professional":
      return 100;
    case "starter":
      return 10;
    default:
      return FREE_DEVICE_LIMIT;
  }
}

async function reconcileTenantDevices(
  client: PoolClient,
  tenantId: string,
  limit: number,
): Promise<void> {
  if (limit === -1) {
    await client.query(
      `UPDATE devices
          SET disabled = FALSE
        WHERE tenant_id = $1
          AND disabled = TRUE`,
      [tenantId],
    );
    return;
  }

  await client.query(
    `WITH ranked AS (
       SELECT id,
              ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
         FROM devices
        WHERE tenant_id = $1
     )
     UPDATE devices d
        SET disabled = ranked.rn > $2
       FROM ranked
      WHERE d.id = ranked.id`,
    [tenantId, limit],
  );
}

async function getOwnerByTenant(
  client: PoolClient,
  tenantId: string,
): Promise<{ tenantId: string; email: string } | null> {
  const { rows } = await client.query(
    `SELECT tenant_id AS "tenantId", email
       FROM tenant_users
      WHERE tenant_id = $1
        AND role IN ('owner', 'admin')
      ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END
      LIMIT 1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

async function findBillingContext(
  client: PoolClient,
  lookup: {
    tenantId?: string | null;
    subscriptionId?: string | null;
    customerId?: string | null;
  },
): Promise<BillingContext | null> {
  if (lookup.tenantId) {
    const { rows } = await client.query(
      `SELECT tb.tenant_id AS "tenantId",
              tb.plan,
              tb.status,
              tb.stripe_customer_id AS "stripeCustomerId",
              tb.stripe_subscription_id AS "stripeSubscriptionId",
              t.current_period_end AS "currentPeriodEnd"
         FROM tenant_billing tb
         JOIN tenants t ON t.id = tb.tenant_id
        WHERE tb.tenant_id = $1
        LIMIT 1`,
      [lookup.tenantId],
    );
    return rows[0] ?? null;
  }

  if (lookup.subscriptionId) {
    const { rows } = await client.query(
      `SELECT tb.tenant_id AS "tenantId",
              tb.plan,
              tb.status,
              tb.stripe_customer_id AS "stripeCustomerId",
              tb.stripe_subscription_id AS "stripeSubscriptionId",
              t.current_period_end AS "currentPeriodEnd"
         FROM tenant_billing tb
         JOIN tenants t ON t.id = tb.tenant_id
        WHERE tb.stripe_subscription_id = $1
        LIMIT 1`,
      [lookup.subscriptionId],
    );
    return rows[0] ?? null;
  }

  if (lookup.customerId) {
    const { rows } = await client.query(
      `SELECT tb.tenant_id AS "tenantId",
              tb.plan,
              tb.status,
              tb.stripe_customer_id AS "stripeCustomerId",
              tb.stripe_subscription_id AS "stripeSubscriptionId",
              t.current_period_end AS "currentPeriodEnd"
         FROM tenant_billing tb
         JOIN tenants t ON t.id = tb.tenant_id
        WHERE tb.stripe_customer_id = $1
        LIMIT 1`,
      [lookup.customerId],
    );
    return rows[0] ?? null;
  }

  return null;
}

async function markProcessed(
  client: PoolClient,
  job: StripeWebhookJob,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING stripe_event_id`,
    [job.stripeEventId, job.stripeEventType],
  );

  return (result.rowCount ?? 0) > 0;
}

function retryDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
}

async function processStripeEvent(
  job: StripeWebhookJob,
  channel: Channel,
): Promise<void> {
  const client = await db.connect();
  const postCommitEmails: EmailJob[] = [];

  try {
    await client.query("BEGIN");

    const accepted = await markProcessed(client, job);
    if (!accepted) {
      await client.query("ROLLBACK");
      console.log(`[stripe] already processed event ${job.stripeEventId} — skipping`);
      return;
    }

    console.log(`[stripe] processing ${job.stripeEventType} event=${job.stripeEventId}`);

    switch (job.stripeEventType) {
      case "checkout.session.completed": {
        const session = job.payload as Record<string, any>;
        const tenantId = session.metadata?.tenantId as string | undefined;
        const plan = normalizePlan(session.metadata?.plan);
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;
        const customerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id;

        if (tenantId && subscriptionId) {
          await client.query(
            `INSERT INTO tenant_billing
               (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
             ON CONFLICT (tenant_id) DO UPDATE
               SET stripe_customer_id = COALESCE($2, tenant_billing.stripe_customer_id),
                   stripe_subscription_id = $3,
                   plan = $4,
                   status = 'active',
                   updated_at = NOW()`,
            [tenantId, customerId ?? null, subscriptionId, plan],
          );
          await client.query(
            `UPDATE tenants
                SET subscription_status = 'active',
                    plan = $1,
                    updated_at = NOW()
              WHERE id = $2`,
            [plan, tenantId],
          );
          await reconcileTenantDevices(client, tenantId, planDeviceLimit(plan, "active", null));
          console.log(`[stripe] tenant=${tenantId} activated plan=${plan}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = job.payload as Record<string, any>;
        const context = await findBillingContext(client, {
          tenantId: subscription.metadata?.tenantId as string | undefined,
          subscriptionId: subscription.id as string | undefined,
          customerId:
            (typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer?.id) as string | undefined,
        });
        if (!context) {
          break;
        }

        const plan = normalizePlan(
          subscription.metadata?.plan ??
            subscription.items?.data?.[0]?.price?.metadata?.plan,
          context.plan,
        );
        const status = normalizePlan(subscription.status, context.status);
        const currentPeriodEnd = toDate(subscription.current_period_end);
        const trialEndsAt = toDate(subscription.trial_end);
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer?.id ?? context.stripeCustomerId;

        await client.query(
          `UPDATE tenant_billing
              SET stripe_customer_id = COALESCE($1, stripe_customer_id),
                  stripe_subscription_id = $2,
                  status = $3,
                  plan = $4,
                  trial_ends_at = $5,
                  updated_at = NOW()
            WHERE tenant_id = $6`,
          [
            customerId ?? null,
            subscription.id,
            status,
            plan,
            trialEndsAt,
            context.tenantId,
          ],
        );
        await client.query(
          `UPDATE tenants
              SET subscription_status = $1,
                  plan = $2,
                  current_period_end = $3,
                  updated_at = NOW()
            WHERE id = $4`,
          [status, plan, currentPeriodEnd, context.tenantId],
        );
        await reconcileTenantDevices(
          client,
          context.tenantId,
          planDeviceLimit(plan, status, currentPeriodEnd),
        );
        console.log(
          `[stripe] tenant=${context.tenantId} subscription updated status=${status} plan=${plan}`,
        );
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = job.payload as Record<string, any>;
        const context = await findBillingContext(client, {
          subscriptionId: subscription.id as string | undefined,
          customerId:
            (typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer?.id) as string | undefined,
        });
        if (!context) {
          break;
        }

        await client.query(
          `UPDATE tenant_billing
              SET status = 'cancelled',
                  plan = 'free',
                  stripe_subscription_id = NULL,
                  trial_ends_at = NULL,
                  updated_at = NOW()
            WHERE tenant_id = $1`,
          [context.tenantId],
        );
        await client.query(
          `UPDATE tenants
              SET subscription_status = 'cancelled',
                  plan = 'free',
                  current_period_end = NULL,
                  updated_at = NOW()
            WHERE id = $1`,
          [context.tenantId],
        );
        await reconcileTenantDevices(client, context.tenantId, FREE_DEVICE_LIMIT);

        console.log(
          `[stripe] subscription cancelled + devices capped to free tier tenant=${context.tenantId}`,
        );
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = job.payload as Record<string, any>;
        const context = await findBillingContext(client, {
          subscriptionId: invoice.subscription as string | undefined,
          customerId:
            (typeof invoice.customer === "string"
              ? invoice.customer
              : invoice.customer?.id) as string | undefined,
        });
        if (!context) {
          break;
        }

        const currentPeriodEnd = toDate(
          invoice.lines?.data?.[0]?.period?.end ?? invoice.period_end,
        );

        await client.query(
          `UPDATE tenant_billing
              SET status = 'active',
                  updated_at = NOW()
            WHERE tenant_id = $1`,
          [context.tenantId],
        );
        await client.query(
          `UPDATE tenants
              SET subscription_status = 'active',
                  current_period_end = COALESCE($1, current_period_end),
                  updated_at = NOW()
            WHERE id = $2`,
          [currentPeriodEnd, context.tenantId],
        );
        await reconcileTenantDevices(
          client,
          context.tenantId,
          planDeviceLimit(context.plan, "active", currentPeriodEnd ?? context.currentPeriodEnd),
        );
        break;
      }

      case "invoice.payment_failed": {
        const invoice = job.payload as Record<string, any>;
        const context = await findBillingContext(client, {
          subscriptionId: invoice.subscription as string | undefined,
          customerId:
            (typeof invoice.customer === "string"
              ? invoice.customer
              : invoice.customer?.id) as string | undefined,
        });
        if (!context) {
          break;
        }

        await client.query(
          `UPDATE tenant_billing
              SET status = 'past_due',
                  updated_at = NOW()
            WHERE tenant_id = $1`,
          [context.tenantId],
        );
        await client.query(
          `UPDATE tenants
              SET subscription_status = 'past_due',
                  updated_at = NOW()
            WHERE id = $1`,
          [context.tenantId],
        );
        await reconcileTenantDevices(
          client,
          context.tenantId,
          planDeviceLimit(
            context.plan,
            "past_due",
            context.currentPeriodEnd,
          ),
        );

        const owner = await getOwnerByTenant(client, context.tenantId);
        if (owner) {
          postCommitEmails.push({
            type: "invoice",
            to: owner.email,
            tenantId: owner.tenantId,
            subject: "Action required: Payment failed for your GrainGuard subscription",
            body:
              "Your recent payment failed. Please update your payment method to avoid service interruption.\n\n" +
              `Invoice: ${invoice.hosted_invoice_url ?? "Check your billing portal"}`,
          });
        }

        console.warn(`[stripe] payment failed tenant=${context.tenantId}`);
        break;
      }

      case "customer.subscription.trial_will_end": {
        const subscription = job.payload as Record<string, any>;
        const context = await findBillingContext(client, {
          subscriptionId: subscription.id as string | undefined,
          customerId:
            (typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer?.id) as string | undefined,
        });
        if (!context) {
          break;
        }

        const owner = await getOwnerByTenant(client, context.tenantId);
        if (owner) {
          const trialEndDate = new Date(
            Number(subscription.trial_end) * 1000,
          ).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          });
          postCommitEmails.push({
            type: "invoice",
            to: owner.email,
            tenantId: owner.tenantId,
            subject: `Your GrainGuard trial ends on ${trialEndDate}`,
            body: `Your free trial ends on ${trialEndDate}. Add a payment method to continue without interruption.`,
          });
        }
        break;
      }

      default:
        console.log(`[stripe] unhandled event type: ${job.stripeEventType}`);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  for (const emailJob of postCommitEmails) {
    queueEmail(channel, emailJob);
  }
}

export function startStripeWorker(channel: Channel): void {
  channel.consume(QUEUES.STRIPE_BILLING, async (msg) => {
    if (!msg) return;

    let job: StripeWebhookJob;
    try {
      job = JSON.parse(msg.content.toString()) as StripeWebhookJob;
    } catch {
      console.error("[stripe] malformed message — sending to DLQ");
      channel.nack(msg, false, false);
      return;
    }

    const attempt = (msg.properties.headers?.["x-retry-count"] as number) || 0;

    try {
      await processStripeEvent(job, channel);
      channel.ack(msg);
    } catch (err: any) {
      console.error(
        `[stripe] failed attempt ${attempt + 1}/${MAX_RETRIES}:`,
        err.message || err,
      );

      if (attempt >= MAX_RETRIES - 1) {
        console.error(
          `[stripe] max retries for event ${job.stripeEventId} — routing to DLQ`,
        );
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        console.log(
          `[stripe] retrying event ${job.stripeEventId} in ${Math.round(delay)}ms`,
        );
        setTimeout(() => {
          channel.sendToQueue(QUEUES.STRIPE_BILLING, msg.content, {
            persistent: true,
            headers: { "x-retry-count": attempt + 1 },
          });
          channel.ack(msg);
        }, delay);
      }
    }
  });

  console.log(`[stripe] worker listening on ${QUEUES.STRIPE_BILLING}`);
}
