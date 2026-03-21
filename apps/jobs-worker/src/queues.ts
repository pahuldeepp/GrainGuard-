// review-sweep
export const EXCHANGE = "grainguard";

export const QUEUES = {
  EMAILS:   "grainguard.emails",
  WEBHOOKS: "grainguard.webhooks",
  EXPORTS:  "grainguard.exports",
  ALERTS:   "grainguard.alerts",
} as const;

export const DLQ = {
  EMAILS:   "grainguard.emails.dlq",
  WEBHOOKS: "grainguard.webhooks.dlq",
  EXPORTS:  "grainguard.exports.dlq",
  ALERTS:   "grainguard.alerts.dlq",
} as const;

// Job payload types
export interface EmailJob {
  to: string;
  subject: string;
  body: string;
  tenantId: string;
  type: "welcome" | "alert" | "usage_warning" | "invoice";
}

export interface WebhookJob {
  url: string;
  payload: Record<string, unknown>;
  tenantId: string;
  secret: string;
  eventType: string;
  attempt: number;
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
}
