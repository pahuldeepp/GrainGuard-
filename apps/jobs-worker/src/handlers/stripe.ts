import { Channel } from "amqplib";
import { QUEUES, StripeWebhookJob } from "../queues";
import { db } from "../db";

const MAX_RETRIES = 3;

/**
 * Processes Stripe webhook events from RabbitMQ with full idempotency.
 *
 * Flow:
 *   gateway receives webhook → verifies Stripe signature → publishes here
 *   → idempotency check (stripe_webhook_events) → update tenant_billing
 *   → on failure: retry with backoff → DLQ after MAX_RETRIES
 */
async function processStripeEvent(job: StripeWebhookJob): Promise<void> {
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
        // Mirror onto tenants for fast joins
        await db.query(
          `UPDATE tenants SET subscription_status = 'active' WHERE id = $1`,
          [tenantId]
        );
        console.log(`[stripe] tenant=${tenantId} activated plan=${plan}`);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub      = job.payload as any;
      const tenantId = sub.metadata?.tenantId;

      if (tenantId) {
        const plan = sub.items?.data?.[0]?.price?.metadata?.plan ?? "unknown";
        await db.query(
          `UPDATE tenant_billing
           SET status = $1, plan = $2, updated_at = NOW()
           WHERE stripe_subscription_id = $3`,
          [sub.status, plan, sub.id]
        );
        await db.query(
          `UPDATE tenants SET subscription_status = $1 WHERE id = $2`,
          [sub.status, tenantId]
        );
        console.log(`[stripe] tenant=${tenantId} subscription updated status=${sub.status}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = job.payload as any;
      await db.query(
        `UPDATE tenant_billing
         SET status = 'cancelled', plan = 'free', updated_at = NOW()
         WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
      // Also clear subscription_status on tenants
      await db.query(
        `UPDATE tenants t
         SET subscription_status = 'cancelled'
         FROM tenant_billing tb
         WHERE tb.tenant_id = t.id
           AND tb.stripe_subscription_id = $1`,
        [sub.id]
      );
      console.log(`[stripe] subscription cancelled sub=${sub.id}`);
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice  = job.payload as any;
      const subId    = invoice.subscription;
      if (subId) {
        await db.query(
          `UPDATE tenant_billing
           SET status = 'active', updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [subId]
        );
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice  = job.payload as any;
      const subId    = invoice.subscription;
      if (subId) {
        await db.query(
          `UPDATE tenant_billing
           SET status = 'past_due', updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [subId]
        );
      }
      console.warn(`[stripe] payment failed for subscription ${subId}`);
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
      await processStripeEvent(job);
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
