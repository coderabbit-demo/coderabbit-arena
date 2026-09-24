import { Actor } from "../auth/types";
import { Booking, Resource } from "../domain/types";
import { Role } from "../auth/types";

/**
 * Everything interesting that happens in the system is described by one of
 * these events. They drive the audit log and outbound webhooks, so adding a
 * new mutation means adding an event here first.
 */
export type DomainEvent =
  | { type: "resource.created"; resource: Resource }
  | { type: "booking.created"; booking: Booking }
  | { type: "booking.series.created"; seriesId: string; bookings: Booking[] }
  | { type: "booking.cancelled"; booking: Booking }
  | { type: "apikey.issued"; keyId: string; role: Role }
  | { type: "apikey.revoked"; keyId: string }
  | { type: "webhook.registered"; webhookId: string; url: string }
  | { type: "webhook.removed"; webhookId: string }
  | { type: "note.added"; noteId: string; bookingId: string; text: string }
  | {
      type: "attachment.uploaded";
      attachmentId: string;
      bookingId: string;
      filename: string;
      size: number;
    }
  | { type: "attachment.removed"; attachmentId: string; bookingId: string }
  | {
      type: "invite.created";
      inviteId: string;
      email: string;
      role: Role;
      token: string;
      expiresAt: string;
    }
  | { type: "invite.accepted"; inviteId: string; keyId: string; role: Role }
  | {
      type: "import.completed";
      resourcesCreated: number;
      bookingsCreated: number;
      skipped: number;
    };

export type EventType = DomainEvent["type"];

/** Subscribe to a single event type or to everything with "*". */
export type EventPattern = EventType | "*";

/** An event plus the metadata every consumer needs. */
export interface EventEnvelope<E extends DomainEvent = DomainEvent> {
  /** Unique id, also used as an idempotency key by webhook receivers. */
  id: string;
  occurredAt: string;
  /** Who caused the event, or null for system actions such as bootstrap. */
  actor: Actor | null;
  event: E;
}

export type EventHandler = (envelope: EventEnvelope) => void;

export const EVENT_TYPES: readonly EventType[] = [
  "resource.created",
  "booking.created",
  "booking.series.created",
  "booking.cancelled",
  "apikey.issued",
  "apikey.revoked",
  "webhook.registered",
  "webhook.removed",
  "note.added",
  "attachment.uploaded",
  "attachment.removed",
  "invite.created",
  "invite.accepted",
  "import.completed",
];

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}
