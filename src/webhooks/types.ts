import { EventType } from "../events/types";

/** A registered outbound webhook endpoint. */
export interface Webhook {
  id: string;
  /** Absolute http(s) URL that receives POSTed event envelopes. */
  url: string;
  /** Event types to deliver, or ["*"] for everything. */
  events: Array<EventType | "*">;
  /** Shared secret used to HMAC-sign each delivery. */
  secret: string;
  description: string;
  active: boolean;
  createdAt: string;
  /** Key id of whoever registered it. */
  createdBy: string;
}

export interface CreateWebhookInput {
  url: string;
  events?: Array<EventType | "*">;
  /** Optional caller-provided secret; one is generated when omitted. */
  secret?: string;
  description?: string;
}

export type DeliveryStatus = "pending" | "delivered" | "failed";

/** The outcome of delivering one event to one webhook, including retries. */
export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: EventType;
  status: DeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Raised for invalid webhook registrations (HTTP 400). */
export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}
