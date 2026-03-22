import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-02-25.clover",
});

export const PLANS = {
  starter:      { priceId: process.env.STRIPE_PRICE_STARTER!,      devices: 10  },
  professional: { priceId: process.env.STRIPE_PRICE_PROFESSIONAL!, devices: 100 },
  enterprise:   { priceId: process.env.STRIPE_PRICE_ENTERPRISE!,   devices: -1  }, // unlimited
} as const;

export type PlanKey = keyof typeof PLANS;
