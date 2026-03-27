import { Channel } from "amqplib";
import { QUEUES, StripeWebhookJob, EmailJob } from "../queues";
import { db } from "../db";

const MAX_RETRIES = 3;

function queueEmail(channel: Channel, job: EmailJob): void {
  channel.sendToQueue(QUEUES.EMAILS, Buffer.from(JSON.stringify(job)), { persistent: true });
}

async function getOwnerBySubscription(subId: string): Promise<{ tenantId: string; email: string } | null> {
  const { rows } = await db.query(
    `SELECT t.id AS "tenantId", tu.email
     FROM tenant_billing tb
     JOIN tenants t       ON t.id = tb.tenant_id
     JOIN tenant_users tu ON tu.tenant_id = t.id AND tu.role = 'owner'
     WHERE tb.stripe_subscription_id = $1
     LIMIT 1`,
    [subId]
  );
  return rows[0] ?? null;
}

/**
 * Processes Stripe webhook events from RabbitMQ with full idempotency.
 *
 * Flow:
 *   gateway receives webhook → verifies Stripe signature → publishes here
 *   → idempotency check (stripe_webhook_events) → update tenant_billing
 *   → on failure: retry with backoff → DLQ after MAX_RETRIES
 */
async function processStripeEvent(job: StripeWebhookJob, channel: Channel): Promise<void> {
  // ── Idempotency check ───────────────────────────────────────────────────────
  // INSERT ... ON CONFLICT DO NOTHING returns 0 rows if already processed.
  const result = await db.query(
    `INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING stripe_event_id`,
    [job.stripeEventId, job.stripeEventType]
  );

  if (result.rowCount === 0) {
    console.log(`[stripe] already processed event ${job.stripeEventId} — skipping`);
    return;
  }

  console.log(`[stripe] processing ${job.stripeEventType} event=${job.stripeEventId}`);

  switch (job.stripeEventType) {
    case "checkout.session.completed": {
      const session  = job.payload as any;
      const tenantId = session.metadata?.tenantId;
      const plan     = session.metadata?.plan;

      if (tenantId && plan && session.subscription) {
        await db.query(
          `UPDATE tenant_billing
           SET stripe_subscription_id = $1,
               plan     = $2,
               status   = 'active',
               updated_at = NOW()
           WHERE tenant_id = $3`,
          [session.subscription, plan, tenantId]
        );
        await db.query(
          `UPDATE tenants SET subscription_status = 'active', plan = $1 WHERE id = $2`,
          [plan, tenantId]
        );
        console.log(`[stripe] tenant=${tenantId} activated plan=${plan}`);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = job.payload as any;
      let tenantId = sub.metadata?.tenantId;

      if (!tenantId) {
        const { rows } = await db.query(
          `SELECT tenant_id FROM tenant_billing WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        tenantId = rows[0]?.tenant_id;
      }

      if (tenantId) {
        const plan =
          sub.metadata?.plan ??
          sub.items?.data?.[0]?.price?.metadata?.plan ??
          "unknown";
        await db.query(
          `UPDATE tenant_billing
           SET status = $1, plan = $2, updated_at = NOW()
           WHERE stripe_subscription_id = $3`,
          [sub.status, plan, sub.id]
        );
        await db.query(
          `UPDATE tenants SET subscription_status = $1, plan = $2 WHERE id = $3`,
          [sub.status, plan, tenantId]
        );
        console.log(`[stripe] tenant=${tenantId} subscription updated status=${sub.status}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = job.payload as any;

      // Downgrade billing to free
      await db.query(
        `UPDATE tenant_billing
         SET status = 'cancelled', plan = 'free', stripe_subscription_id = NULL, updated_at = NOW()
         WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
      await db.query(
        `UPDATE tenants t
         SET subscription_status = 'cancelled', plan = 'free'
         FROM tenant_billing tb
         WHERE tb.tenant_id = t.id
           AND tb.stripe_subscription_id = $1`,
        [sub.id]
      );

      // Soft-disable devices beyond free tier limit (5), oldest devices kept
      await db.query(
        `UPDATE devices SET disabled = TRUE
         WHERE tenant_id = (
           SELECT tenant_id FROM tenant_billing WHERE stripe_subscription_id = $1
         )
         AND id NOT IN (
           SELECT id FROM devices
           WHERE tenant_id = (
             SELECT tenant_id FROM tenant_billing WHERE stripe_subscription_id = $1
           )
           ORDER BY created_at ASC
           LIMIT 5
         )`,
        [sub.id]
      );

      console.log(`[stripe] subscription cancelled + devices capped to free tier sub=${sub.id}`);
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = job.payload as any;
      const subId   = invoice.subscription;
      if (subId) {
        await db.query(
          `UPDATE tenant_billing
           SET status = 'active', updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [subId]
        );
        await db.query(
          `UPDATE tenants t SET subscription_status = 'active'
           FROM tenant_billing tb
           WHERE tb.tenant_id = t.id AND tb.stripe_subscription_id = $1`,
          [subId]
        );
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = job.payload as any;
      const subId   = invoice.subscription;
      if (!subId) break;

      await db.query(
        `UPDATE tenant_billing
         SET status = 'past_due', updated_at = NOW()
         WHERE stripe_subscription_id = $1`,
        [subId]
      );
      await db.query(
        `UPDATE tenants t SET subscription_status = 'past_due'
         FROM tenant_billing tb
         WHERE tb.tenant_id = t.id AND tb.stripe_subscription_id = $1`,
        [subId]
      );

      const owner = await getOwnerBySubscription(subId);
      if (owner) {
        queueEmail(channel, {
          type:     "invoice",
          to:       owner.email,
          tenantId: owner.tenantId,
          subject:  "Action required: Payment failed for your GrainGuard subscription",
          body:     `Your recent payment failed. Please update your payment method to avoid service interruption.\n\nInvoice: ${invoice.hosted_invoice_url ?? "Check your billing portal"}`,
        });
      }

      console.warn(`[stripe] payment failed sub=${subId}`);
      break;
    }

    case "customer.subscription.trial_will_end": {
      // Fires 3 days before trial ends
      const sub = job.payload as any;
      const owner = await getOwnerBySubscription(sub.id);
      if (owner) {
        const trialEndDate = new Date((sub.trial_end as number) * 1000).toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric",
        });
        queueEmail(channel, {
          type:     "invoice",
          to:       owner.email,
          tenantId: owner.tenantId,
          subject:  `Your GrainGuard trial ends on ${trialEndDate}`,
          body:     `Your free trial ends on ${trialEndDate}. Add a payment method to continue without interruption.`,
        });
      }
      break;
    }

    default:
      console.log(`[stripe] unhandled event type: ${job.stripeEventType}`);
  }
}

function retryDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
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
      console.error(`[stripe] failed attempt ${attempt + 1}/${MAX_RETRIES}:`, err.message || err);

      if (attempt >= MAX_RETRIES - 1) {
        console.error(`[stripe] max retries for event ${job.stripeEventId} — routing to DLQ`);
        channel.nack(msg, false, false);
      } else {
        const delay = retryDelay(attempt);
        console.log(`[stripe] retrying event ${job.stripeEventId} in ${Math.round(delay)}ms`);
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
