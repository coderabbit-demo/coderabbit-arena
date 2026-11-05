import { randomUUID } from "crypto";
import { BookingStore } from "../store/store";
import { overlaps, parseRange, ValidationError } from "../domain/time";
import {
  Booking,
  CreateBookingInput,
  CreateResourceInput,
  Resource,
  TimeRange,
} from "../domain/types";
import { expand } from "../recurrence/recurrence";
import { RecurrenceRule } from "../recurrence/types";
import { buildUtilizationReport } from "../reports/reports";
import { ReportInput, UtilizationReport } from "../reports/types";
import { EventBus } from "../events/bus";
import { Actor, ForbiddenError } from "../auth/types";
import { actorCan, assertPermission } from "../auth/apiKeys";

/** Input for creating a whole series of bookings from a recurrence rule. */
export interface CreateRecurringBookingInput extends CreateBookingInput {
  rule: RecurrenceRule;
}

/** The result of creating a recurring booking series. */
export interface RecurringBookingResult {
  /** Stable id linking all bookings in the series. */
  seriesId: string;
  bookings: Booking[];
}

export interface ListBookingsQuery {
  resourceId?: string;
  /** Page size, 1..MAX_PAGE_SIZE (default DEFAULT_PAGE_SIZE). */
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

/** One page of bookings, ordered by start then id. */
export interface BookingPage {
  data: Booking[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

interface CursorPosition {
  start: string;
  id: string;
}

function encodeCursor(booking: Booking): string {
  const position: CursorPosition = { start: booking.start, id: booking.id };
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed?.start === "string" && typeof parsed?.id === "string") {
      return parsed;
    }
  } catch {
    // fall through to the validation error below
  }
  throw new ValidationError("Invalid cursor");
}

/** Keyset order for pagination: start ascending, id as a tie-breaker. */
function compareBookings(a: CursorPosition, b: CursorPosition): number {
  return a.start.localeCompare(b.start) || a.id.localeCompare(b.id);
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Core booking use-cases. Every mutation takes the acting API key so that
 * ownership can be enforced and the resulting event is attributed correctly.
 */
export class BookingService {
  constructor(
    private readonly store: BookingStore,
    private readonly bus: EventBus = new EventBus(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  createResource(input: CreateResourceInput, actor: Actor): Resource {
    assertPermission(actor, "resources:write");

    const name = input.name?.trim();
    if (!name) {
      throw new ValidationError("Resource name is required");
    }
    const capacity = input.capacity ?? 1;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new ValidationError("Capacity must be a positive integer");
    }

    const resource = this.store.addResource({
      id: randomUUID(),
      name,
      capacity,
      createdBy: actor.keyId,
    });
    this.bus.publish({ type: "resource.created", resource }, actor);
    return resource;
  }

  listResources(): Resource[] {
    return this.store.listResources();
  }

  /** Look up a single resource, or undefined if it does not exist. */
  getResource(id: string): Resource | undefined {
    return this.store.getResource(id);
  }

  /** Confirmed bookings for a resource, used by the public calendar feed. */
  bookingsForResource(resourceId: string): Booking[] {
    return this.store.bookingsForResource(resourceId, true);
  }

  createBooking(input: CreateBookingInput, actor: Actor): Booking {
    assertPermission(actor, "bookings:write");

    const bookedBy = input.bookedBy?.trim();
    if (!bookedBy) {
      throw new ValidationError("bookedBy is required");
    }

    const resource = this.store.getResource(input.resourceId);
    if (!resource) {
      throw new NotFoundError(`Resource not found: ${input.resourceId}`);
    }

    const range = parseRange(input.start, input.end);
    this.assertAvailable(resource, range);

    const booking = this.store.addBooking(
      this.buildBooking(resource, bookedBy, range, actor, input.private === true),
    );
    this.bus.publish({ type: "booking.created", booking }, actor);
    return booking;
  }

  /**
   * Create a whole series of bookings from a recurrence rule. Every occurrence
   * is checked for conflicts before anything is persisted, so a single clash
   * rejects the entire series (all-or-nothing).
   */
  createRecurringBooking(
    input: CreateRecurringBookingInput,
    actor: Actor,
  ): RecurringBookingResult {
    assertPermission(actor, "bookings:write");

    const bookedBy = input.bookedBy?.trim();
    if (!bookedBy) {
      throw new ValidationError("bookedBy is required");
    }

    const resource = this.store.getResource(input.resourceId);
    if (!resource) {
      throw new NotFoundError(`Resource not found: ${input.resourceId}`);
    }

    const base = parseRange(input.start, input.end);
    const occurrences = expand({
      start: base.start,
      end: base.end,
      rule: input.rule,
    });

    // Validate the whole series up front so we never persist a partial series.
    for (const occ of occurrences) {
      this.assertAvailable(resource, occ, occurrences);
    }

    const seriesId = randomUUID();
    const preparedBookings = occurrences.map((occ) => {
      const booking = this.buildBooking(resource, bookedBy, occ, actor, input.private === true);
      booking.seriesId = seriesId;
      return booking;
    });
    const bookings = preparedBookings.map((booking) => this.store.addBooking(booking));

    this.bus.publish({ type: "booking.series.created", seriesId, bookings }, actor);
    return { seriesId, bookings };
  }

  /**
   * Cancel a booking. Members may only cancel bookings created with their own
   * key; holders of `bookings:cancel:any` (admins and service keys) may
   * cancel anything, unless their key was scoped down.
   */
  cancelBooking(id: string, actor: Actor): Booking {
    assertPermission(actor, "bookings:write");

    const booking = this.store.getBooking(id);
    if (!booking) {
      throw new NotFoundError(`Booking not found: ${id}`);
    }
    if (
      booking.createdBy !== actor.keyId &&
      !actorCan(actor, "bookings:cancel:any")
    ) {
      throw new ForbiddenError("Only the creator or an admin may cancel this booking");
    }
    if (booking.status === "cancelled") {
      return booking;
    }

    const cancelled = this.store.updateBooking({
      ...booking,
      status: "cancelled",
      cancelledAt: this.clock().toISOString(),
      cancelledBy: actor.keyId,
    });
    this.bus.publish(
      {
        type: "booking.cancelled",
        bookingId: cancelled.id,
        resourceId: cancelled.resourceId,
        cancelledAt: cancelled.cancelledAt as string,
        cancelledBy: actor.keyId,
      },
      actor,
    );
    return cancelled;
  }

  /**
   * List bookings visible to `actor`. Private bookings are only returned to
   * the key that created them and to keys allowed to read private bookings.
   */
  listBookings(actor: Actor, resourceId?: string): Booking[] {
    const bookings = resourceId
      ? this.store.bookingsForResource(resourceId)
      : this.store.listBookings();
    const seesPrivate = hasPermission(actor.role, "bookings:read:private");
    return bookings.filter(
      (b) => !b.private || seesPrivate || b.createdBy === actor.keyId,
    );
  }

  /**
   * Cursor-paginated listing. Pages are keyed on (start, id) rather than an
   * offset so bookings created while a client is paging do not shift later
   * pages and cause duplicates or gaps.
   */
  listBookingsPage(query: ListBookingsQuery = {}): BookingPage {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new ValidationError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const sorted = this.listBookings(query.resourceId)
      .filter((b) => !after || compareBookings(b, after) > 0)
      .sort(compareBookings);

    const data = sorted.slice(0, limit);
    const hasMore = sorted.length > limit;
    return { data, nextCursor: hasMore ? encodeCursor(data[data.length - 1]) : null };
  }

  /**
   * Build a utilization report across all resources for a time window,
   * optionally estimating revenue from pricing rules. Only confirmed bookings
   * count toward utilization.
   */
  utilizationReport(input: ReportInput): UtilizationReport {
    return buildUtilizationReport(
      this.store.listResources(),
      (resourceId) => this.store.bookingsForResource(resourceId, true),
      input,
    );
  }

  /**
   * Throw a ConflictError if `range` cannot be booked on `resource`. Counts
   * both already-confirmed bookings and any `siblings` from the same request
   * that overlap the range, so a self-overlapping series is rejected too.
   */
  private assertAvailable(
    resource: Resource,
    range: TimeRange,
    siblings: TimeRange[] = [],
  ): void {
    const existing = this.store
      .bookingsForResource(resource.id, true)
      .filter((b) => overlaps(range, parseRange(b.start, b.end)));

    const overlappingSiblings = siblings.filter(
      (s) => s !== range && overlaps(range, s),
    );

    const concurrent = existing.length + overlappingSiblings.length;
    if (concurrent >= resource.capacity) {
      throw new ConflictError(
        `Resource "${resource.name}" is fully booked for the requested time`,
      );
    }
  }

  private buildBooking(
    resource: Resource,
    bookedBy: string,
    range: TimeRange,
    actor: Actor,
    isPrivate: boolean,
  ): Booking {
    return {
      id: randomUUID(),
      resourceId: resource.id,
      bookedBy,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      status: "confirmed",
      createdAt: this.clock().toISOString(),
      createdBy: actor.keyId,
      ...(isPrivate ? { private: true } : {}),
    };
  }
}
