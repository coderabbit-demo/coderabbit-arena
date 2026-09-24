import { randomUUID } from "crypto";
import { EventBus } from "../events/bus";
import { DomainEvent, EventEnvelope, EventType } from "../events/types";

/** One immutable line in the audit trail. */
export interface AuditEntry {
  id: string;
  occurredAt: string;
  /** Event that produced this entry. */
  action: EventType;
  /** Id of the API key that caused it, or null for system actions. */
  actorKeyId: string | null;
  actorName: string | null;
  /** Kind of object affected, e.g. "booking". */
  subjectType: string;
  /** Id of the affected object. */
  subjectId: string;
  /** Small, event-specific bag of extra context safe to show to auditors. */
  details: Record<string, unknown>;
}

export interface AuditQuery {
  action?: EventType;
  actorKeyId?: string;
  subjectId?: string;
  /** Inclusive lower bound (ISO-8601). */
  from?: string;
  /** Exclusive upper bound (ISO-8601). */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

/** Persistence needed by the audit log; implemented by the main store. */
export interface AuditStore {
  addAuditEntry(entry: AuditEntry): AuditEntry;
  listAuditEntries(): AuditEntry[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Describe which object an event is about and any extra context worth
 * keeping. Keep payloads small: full objects are recoverable from the store,
 * the audit log only needs enough to answer "who did what to which record".
 */
export function summarize(event: DomainEvent): Pick<AuditEntry, "subjectType" | "subjectId" | "details"> {
  switch (event.type) {
    case "resource.created":
      return {
        subjectType: "resource",
        subjectId: event.resource.id,
        details: { name: event.resource.name, capacity: event.resource.capacity },
      };
    case "booking.created":
      return {
        subjectType: "booking",
        subjectId: event.booking.id,
        details: {
          resourceId: event.booking.resourceId,
          bookedBy: event.booking.bookedBy,
          start: event.booking.start,
          end: event.booking.end,
        },
      };
    case "booking.series.created":
      return {
        subjectType: "booking-series",
        subjectId: event.seriesId,
        details: {
          count: event.bookings.length,
          resourceId: event.bookings[0]?.resourceId ?? null,
          bookingIds: event.bookings.map((b) => b.id),
        },
      };
    case "booking.cancelled":
      return {
        subjectType: "booking",
        subjectId: event.booking.id,
        details: {
          resourceId: event.booking.resourceId,
          cancelledAt: event.booking.cancelledAt ?? null,
        },
      };
    case "apikey.issued":
      return {
        subjectType: "apikey",
        subjectId: event.keyId,
        details: { role: event.role },
      };
    case "apikey.revoked":
      return { subjectType: "apikey", subjectId: event.keyId, details: {} };
    case "webhook.registered":
      return {
        subjectType: "webhook",
        subjectId: event.webhookId,
        details: { url: event.url },
      };
    case "webhook.removed":
      return { subjectType: "webhook", subjectId: event.webhookId, details: {} };
    case "note.added":
      return {
        subjectType: "note",
        subjectId: event.noteId,
        details: { bookingId: event.bookingId, text: event.text },
      };
    case "attachment.uploaded":
      return {
        subjectType: "attachment",
        subjectId: event.attachmentId,
        details: { bookingId: event.bookingId, filename: event.filename, size: event.size },
      };
    case "attachment.removed":
      return {
        subjectType: "attachment",
        subjectId: event.attachmentId,
        details: { bookingId: event.bookingId },
      };
    case "invite.created":
      return {
        subjectType: "invite",
        subjectId: event.inviteId,
        details: {
          email: event.email,
          role: event.role,
          token: event.token,
          expiresAt: event.expiresAt,
        },
      };
    case "invite.accepted":
      return {
        subjectType: "invite",
        subjectId: event.inviteId,
        details: { keyId: event.keyId, role: event.role },
      };
    case "import.completed":
      return {
        subjectType: "import",
        subjectId: `import-${Date.now()}`,
        details: {
          resourcesCreated: event.resourcesCreated,
          bookingsCreated: event.bookingsCreated,
          skipped: event.skipped,
        },
      };
  }
}

/**
 * Append-only audit trail fed by the event bus. Every published event becomes
 * exactly one entry, so the log is a faithful record of all mutations.
 */
export class AuditLog {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: AuditStore,
    bus: EventBus,
  ) {
    this.unsubscribe = bus.subscribe("*", (envelope) => this.record(envelope));
  }

  /** Persist an entry for `envelope`. Public so it can be driven directly in tests. */
  record(envelope: EventEnvelope): AuditEntry {
    const summary = summarize(envelope.event);
    return this.store.addAuditEntry({
      id: randomUUID(),
      occurredAt: envelope.occurredAt,
      action: envelope.event.type,
      actorKeyId: envelope.actor?.keyId ?? null,
      actorName: envelope.actor?.name ?? null,
      ...summary,
    });
  }

  /** Query the log, newest first, with simple offset pagination. */
  query(q: AuditQuery = {}): AuditPage {
    const limit = clampLimit(q.limit);
    const offset = Math.max(0, Math.floor(q.offset ?? 0));

    const fromMs = q.from ? new Date(q.from).getTime() : Number.NEGATIVE_INFINITY;
    const toMs = q.to ? new Date(q.to).getTime() : Number.POSITIVE_INFINITY;

    // Entries are appended in causal order, so reverse before the (stable)
    // sort: events sharing a millisecond keep newest-first ordering.
    const matching = this.store
      .listAuditEntries()
      .reverse()
      .filter((e) => !q.action || e.action === q.action)
      .filter((e) => !q.actorKeyId || e.actorKeyId === q.actorKeyId)
      .filter((e) => !q.subjectId || e.subjectId === q.subjectId)
      .filter((e) => {
        const at = new Date(e.occurredAt).getTime();
        return at >= fromMs && at < toMs;
      })
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    return {
      entries: matching.slice(offset, offset + limit),
      total: matching.length,
      limit,
      offset,
    };
  }

  /** Stop listening to the bus. Mostly useful for tests and graceful shutdown. */
  close(): void {
    this.unsubscribe();
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}
