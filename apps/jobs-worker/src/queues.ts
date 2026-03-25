export const EXCHANGE = "grainguard";

export const QUEUES = {
  EMAILS:          "grainguard.emails",
  WEBHOOKS:        "grainguard.webhooks",
  EXPORTS:         "grainguard.exports",
  ALERTS:          "grainguard.alerts",
  STRIPE_BILLING:  "grainguard.stripe.billing",
} as const;

export const DLQ = {
  EMAILS:          "grainguard.emails.dlq",
  WEBHOOKS:        "grainguard.webhooks.dlq",
  EXPORTS:         "grainguard.exports.dlq",
  ALERTS:          "grainguard.alerts.dlq",
  STRIPE_BILLING:  "grainguard.stripe.billing.dlq",
} as const;

// Job payload types
export interface EmailJob {
  to: string;
  subject: string;
  body: string;
  tenantId: string;
  type: "welcome" | "alert" | "usage_warning" | "invoice" | "invite";
}

export interface WebhookJob {
  url: string;
  payload: Record<string, unknown>;
  tenantId: string;
  secret: string;
  eventType: string;
  attempt: number;
  endpointId?: string;
}

export interface ExportJob {
  tenantId: string;
  userId: string;
  exportType: "devices" | "telemetry";
  filters: Record<string, unknown>;
  deliveryEmail: string;
}

export interface AlertJob {
  tenantId: string;
  deviceId: string;
  serialNumber: string;
  alertType: "temperature" | "humidity" | "offline";
  value: number;
  threshold: number;
  recipients: string[];
  level?: string;
  score?: number;
}

export interface StripeWebhookJob {
  stripeEventId:   string;
  stripeEventType: string;
  payload:         Record<string, unknown>;
}

