import { randomUUID } from "crypto";
import { Actor } from "../auth/types";
import { assertPermission } from "../auth/apiKeys";
import { ValidationError } from "../domain/time";
import { Booking, Resource } from "../domain/types";
import { EventBus } from "../events/bus";
import { EventEnvelope, isEventType } from "../events/types";
import { BookingStore } from "../store/store";
import { isEmailAddress, Mailer, Message } from "./mailer";
import {
  DEFAULT_TEMPLATES,
  NotificationTemplate,
  render,
  renderHtml,
  TemplateError,
  TemplateStore,
  validateTemplate,
} from "./templates";

/** Maps a booker's display name to the address notifications go to. */
export interface Contact {
  name: string;
  email: string;
  /** Opt-out flag; contacts that unsubscribe stay on file so we do not re-add them. */
  subscribed: boolean;
  updatedAt: string;
}

export interface ContactStore {
  putContact(contact: Contact): Contact;
  getContact(name: string): Contact | undefined;
  listContacts(): Contact[];
}

export interface UpsertTemplateInput {
  event: string;
  subject: string;
  body: string;
  html?: boolean;
}

export interface NotificationOptions {
  publicBaseUrl: string;
  clock?: () => Date;
  /** Retry interval for failed sends, in milliseconds. */
  retryIntervalMs?: number;
  onError?: (error: unknown, message: Message) => void;
}

interface PendingSend {
  message: Message;
  attempts: number;
}

/**
 * Turns domain events into emails. Templates can be customised per event by
 * admins; anything without a template is silently skipped.
 */
export class NotificationService {
  private readonly clock: () => Date;
  private readonly publicBaseUrl: string;
  private readonly onError: (error: unknown, message: Message) => void;
  private readonly pending: PendingSend[] = [];
  private readonly unsubscribe: () => void;
  private readonly retryTimer: NodeJS.Timeout;
  /** Sends started but not yet resolved, so shutdown can wait for them. */
  readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly store: TemplateStore & ContactStore & BookingStore,
    bus: EventBus,
    private readonly mailer: Mailer,
    options: NotificationOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.publicBaseUrl = options.publicBaseUrl;
    this.onError = options.onError ?? (() => undefined);
    this.seedTemplates();
    this.unsubscribe = bus.subscribe("*", (envelope) => this.handle(envelope));
    this.retryTimer = setInterval(() => this.flush(), options.retryIntervalMs ?? 30_000);
  }

  // --- contacts -------------------------------------------------------------

  upsertContact(input: { name: string; email: string; subscribed?: boolean }, actor: Actor): Contact {
    assertPermission(actor, "bookings:write");
    const name = input.name?.trim();
    if (!name) {
      throw new ValidationError("Contact name is required");
    }
    if (!isEmailAddress(input.email)) {
      throw new ValidationError(`Invalid email address: ${String(input.email)}`);
    }
    return this.store.putContact({
      name,
      email: input.email,
      subscribed: input.subscribed ?? true,
      updatedAt: this.clock().toISOString(),
    });
  }

  listContacts(actor: Actor): Contact[] {
    assertPermission(actor, "bookings:read");
    return this.store.listContacts();
  }

  // --- templates ------------------------------------------------------------

  upsertTemplate(input: UpsertTemplateInput, actor: Actor): NotificationTemplate {
    assertPermission(actor, "webhooks:manage");
    if (!isEventType(input.event)) {
      throw new TemplateError(`Unknown event type: ${String(input.event)}`);
    }
    if (typeof input.subject !== "string" || typeof input.body !== "string") {
      throw new TemplateError("subject and body are required");
    }
    validateTemplate(input.subject);
    validateTemplate(input.body);
    return this.store.putTemplate({
      id: this.store.getTemplate(input.event)?.id ?? randomUUID(),
      event: input.event,
      subject: input.subject,
      body: input.body,
      html: input.html ?? false,
      updatedAt: this.clock().toISOString(),
      updatedBy: actor.keyId,
    });
  }

  listTemplates(actor: Actor): NotificationTemplate[] {
    assertPermission(actor, "webhooks:manage");
    return this.store.listTemplates();
  }

  /**
   * Render a template with sample data without sending anything, so admins
   * can preview their edits.
   */
  preview(input: UpsertTemplateInput, actor: Actor): { subject: string; body: string } {
    assertPermission(actor, "webhooks:manage");
    const ctx = this.sampleContext();
    return {
      subject: render(input.subject, ctx),
      body: input.html ? renderHtml(input.body, ctx) : render(input.body, ctx),
    };
  }

  // --- delivery -------------------------------------------------------------

  /** Try to send everything in the retry queue. */
  flush(): void {
    const batch = this.pending.splice(0, this.pending.length);
    for (const item of batch) {
      this.dispatch(item);
    }
  }

  /** Resolve once every send started so far has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  close(): void {
    this.unsubscribe();
    clearInterval(this.retryTimer);
  }

  private handle(envelope: EventEnvelope): void {
    const template = this.store.getTemplate(envelope.event.type);
    if (!template) {
      return;
    }
    const ctx = this.contextFor(envelope);
    if (!ctx) {
      return;
    }
    const to = this.recipientFor(ctx);
    if (!to) {
      return;
    }
    const message: Message = {
      to,
      subject: render(template.subject, ctx),
      body: template.html ? renderHtml(template.body, ctx) : render(template.body, ctx),
      html: template.html,
      headers: { "X-Booking-Event": envelope.id },
    };
    this.dispatch({ message, attempts: 0 });
  }

  private dispatch(item: PendingSend): void {
    item.attempts++;
    const p = this.mailer
      .send(item.message)
      .then((result) => {
        if (!result.accepted) {
          this.pending.push(item);
        }
      })
      .catch((err) => {
        this.onError(err, item.message);
        this.pending.push(item);
      });
    this.inFlight.add(p);
    p.finally(() => this.inFlight.delete(p));
  }

  private recipientFor(ctx: Record<string, unknown>): string | null {
    if (typeof ctx.email === "string") {
      return ctx.email;
    }
    const booking = ctx.booking as Booking | undefined;
    if (!booking) {
      return null;
    }
    const contact = this.store.getContact(booking.bookedBy);
    if (!contact || contact.subscribed === false) {
      return null;
    }
    return contact.email;
  }

  private contextFor(envelope: EventEnvelope): Record<string, unknown> | null {
    const event = envelope.event;
    const base = { actor: envelope.actor, occurredAt: envelope.occurredAt };
    switch (event.type) {
      case "booking.created":
      case "booking.cancelled": {
        const resource = this.store.getResource(event.booking.resourceId);
        return { ...base, booking: event.booking, resource };
      }
      case "note.added": {
        const booking = this.store.getBooking(event.bookingId);
        if (!booking) {
          return null;
        }
        return {
          ...base,
          booking,
          resource: this.store.getResource(booking.resourceId),
          note: { text: event.text },
        };
      }
      case "attachment.uploaded": {
        const booking = this.store.getBooking(event.bookingId);
        if (!booking) {
          return null;
        }
        return {
          ...base,
          booking,
          resource: this.store.getResource(booking.resourceId),
          filename: event.filename,
          downloadUrl: `${this.publicBaseUrl}/files/${event.bookingId}/${event.filename}`,
        };
      }
      case "invite.created":
        return {
          ...base,
          email: event.email,
          invite: { role: event.role, expiresAt: event.expiresAt },
          acceptUrl: `${this.publicBaseUrl}/invites/${event.token}/accept`,
        };
      default:
        return null;
    }
  }

  private sampleContext(): Record<string, unknown> {
    const resource: Resource = { id: "res_sample", name: "Boardroom", capacity: 1, createdBy: "sys" };
    const booking: Booking = {
      id: "bk_sample",
      resourceId: resource.id,
      bookedBy: "Ada Lovelace",
      start: "2026-10-01T09:00:00.000Z",
      end: "2026-10-01T10:30:00.000Z",
      status: "confirmed",
      createdAt: "2026-09-20T12:00:00.000Z",
      createdBy: "sys",
    };
    return {
      actor: { keyId: "sys", name: "Front desk", role: "member" },
      booking,
      resource,
      note: { text: "Projector has been replaced." },
      filename: "agenda.pdf",
      downloadUrl: `${this.publicBaseUrl}/files/${booking.id}/agenda.pdf`,
      invite: { role: "member", expiresAt: "2026-10-04T12:00:00.000Z" },
      acceptUrl: `${this.publicBaseUrl}/invites/sample/accept`,
      email: "ada@example.com",
    };
  }

  private seedTemplates(): void {
    for (const t of DEFAULT_TEMPLATES) {
      if (!this.store.getTemplate(t.event)) {
        this.store.putTemplate({
          ...t,
          id: randomUUID(),
          updatedAt: this.clock().toISOString(),
          updatedBy: null,
        });
      }
    }
  }
}
