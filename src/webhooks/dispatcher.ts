import { randomBytes, randomUUID } from "crypto";
import { Actor } from "../auth/types";
import { assertPermission } from "../auth/apiKeys";
import { EventBus } from "../events/bus";
import { EventEnvelope, EventType, isEventType } from "../events/types";
import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "./signing";
import {
  CreateWebhookInput,
  Webhook,
  WebhookDelivery,
  WebhookError,
} from "./types";

/** Minimal HTTP client surface so tests can stub the network. */
export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

export interface DispatcherOptions {
  post?: HttpPost;
  /** Total attempts per delivery including the first (default 3). */
  maxAttempts?: number;
  /** Base delay between attempts; doubles each retry (default 250ms). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
  onError?: (error: unknown, delivery: WebhookDelivery) => void;
}

/** Persistence needed by the webhook service; implemented by the main store. */
export interface WebhookStore {
  addWebhook(webhook: Webhook): Webhook;
  getWebhook(id: string): Webhook | undefined;
  listWebhooks(): Webhook[];
  removeWebhook(id: string): boolean;
  addDelivery(delivery: WebhookDelivery): WebhookDelivery;
  updateDelivery(delivery: WebhookDelivery): WebhookDelivery;
  deliveriesForWebhook(webhookId: string): WebhookDelivery[];
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;
const SECRET_BYTES = 32;
const MAX_URL_LENGTH = 2048;

const defaultPost: HttpPost = async (url, init) => {
  const res = await fetch(url, {
    method: "POST",
    headers: init.headers,
    body: init.body,
  });
  return { status: res.status };
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Subscribes to the event bus and POSTs signed JSON envelopes to every
 * matching webhook. Deliveries are retried with exponential backoff and each
 * outcome is recorded so operators can inspect what was (not) delivered.
 */
export class WebhookService {
  private readonly post: HttpPost;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => Date;
  private readonly onError: (error: unknown, delivery: WebhookDelivery) => void;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: WebhookStore,
    private readonly bus: EventBus,
    options: DispatcherOptions = {},
  ) {
    this.post = options.post ?? defaultPost;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.clock = options.clock ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
    this.unsubscribe = bus.subscribe("*", (envelope) => this.handle(envelope));
  }

  register(input: CreateWebhookInput, actor: Actor): Webhook {
    assertPermission(actor, "webhooks:manage");

    const url = validateUrl(input.url);
    const events = validateEvents(input.events);
    const secret = input.secret ?? randomBytes(SECRET_BYTES).toString("hex");
    if (secret.length < 16) {
      throw new WebhookError("Webhook secret must be at least 16 characters");
    }

    const webhook = this.store.addWebhook({
      id: randomUUID(),
      url,
      events,
      secret,
      description: input.description?.trim() ?? "",
      active: true,
      createdAt: this.clock().toISOString(),
      createdBy: actor.keyId,
    });

    this.bus.publish(
      { type: "webhook.registered", webhookId: webhook.id, url: webhook.url },
      actor,
    );
    return webhook;
  }

  list(actor: Actor): Webhook[] {
    assertPermission(actor, "webhooks:manage");
    return this.store.listWebhooks();
  }

  remove(id: string, actor: Actor): void {
    assertPermission(actor, "webhooks:manage");
    if (!this.store.removeWebhook(id)) {
      throw new WebhookError(`Webhook not found: ${id}`);
    }
    this.bus.publish({ type: "webhook.removed", webhookId: id }, actor);
  }

  deliveries(webhookId: string, actor: Actor): WebhookDelivery[] {
    assertPermission(actor, "webhooks:manage");
    if (!this.store.getWebhook(webhookId)) {
      throw new WebhookError(`Webhook not found: ${webhookId}`);
    }
    return this.store.deliveriesForWebhook(webhookId);
  }

  /** Resolve once every delivery started so far has finished (success or not). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Stop receiving events. In-flight deliveries still complete. */
  close(): void {
    this.unsubscribe();
  }

  private handle(envelope: EventEnvelope): void {
    // Webhook lifecycle events are internal bookkeeping; delivering them would
    // let every endpoint learn about every other endpoint.
    if (envelope.event.type.startsWith("webhook.")) {
      return;
    }
    for (const webhook of this.store.listWebhooks()) {
      if (!webhook.active || !matches(webhook, envelope.event.type)) {
        continue;
      }
      const task = this.deliver(webhook, envelope).finally(() => {
        this.inFlight.delete(task);
      });
      this.inFlight.add(task);
    }
  }

  private async deliver(webhook: Webhook, envelope: EventEnvelope): Promise<WebhookDelivery> {
    let delivery = this.store.addDelivery({
      id: randomUUID(),
      webhookId: webhook.id,
      eventId: envelope.id,
      eventType: envelope.event.type,
      status: "pending",
      attempts: 0,
      lastStatusCode: null,
      lastError: null,
      createdAt: this.clock().toISOString(),
      completedAt: null,
    });

    const body = JSON.stringify(envelope);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const timestamp = Math.floor(this.clock().getTime() / 1000);
      try {
        const res = await this.post(webhook.url, {
          headers: {
            "content-type": "application/json",
            "user-agent": "booking-api-webhooks/1.0",
            [EVENT_ID_HEADER]: envelope.id,
            [TIMESTAMP_HEADER]: String(timestamp),
            [SIGNATURE_HEADER]: sign(webhook.secret, envelope.id, timestamp, body),
          },
          body,
        });

        delivery = this.store.updateDelivery({
          ...delivery,
          attempts: attempt,
          lastStatusCode: res.status,
          lastError: isSuccess(res.status) ? null : `HTTP ${res.status}`,
        });

        if (isSuccess(res.status)) {
          return this.finish(delivery, "delivered");
        }
        // 4xx other than 408/429 will not get better on retry.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          return this.finish(delivery, "failed");
        }
      } catch (err) {
        delivery = this.store.updateDelivery({
          ...delivery,
          attempts: attempt,
          lastError: err instanceof Error ? err.message : String(err),
        });
      }

      if (attempt < this.maxAttempts) {
        await this.sleep(this.backoffMs * 2 ** (attempt - 1));
      }
    }

    const failed = this.finish(delivery, "failed");
    this.onError(new Error(failed.lastError ?? "delivery failed"), failed);
    return failed;
  }

  private finish(delivery: WebhookDelivery, status: WebhookDelivery["status"]): WebhookDelivery {
    return this.store.updateDelivery({
      ...delivery,
      status,
      completedAt: this.clock().toISOString(),
    });
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function matches(webhook: Webhook, type: EventType): boolean {
  return webhook.events.includes("*") || webhook.events.includes(type);
}

function validateUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WebhookError("Webhook url is required");
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new WebhookError(`Webhook url must be at most ${MAX_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebhookError(`Webhook url is not a valid absolute URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebhookError("Webhook url must use http or https");
  }
  return parsed.toString();
}

function validateEvents(raw: unknown): Array<EventType | "*"> {
  if (raw === undefined) {
    return ["*"];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new WebhookError("events must be a non-empty array");
  }
  const events: Array<EventType | "*"> = [];
  for (const value of raw) {
    if (value === "*" || isEventType(value)) {
      events.push(value);
    } else {
      throw new WebhookError(`Unknown event type: ${String(value)}`);
    }
  }
  return [...new Set(events)];
}
