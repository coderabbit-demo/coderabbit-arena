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
      this.buildBooking(resource, bookedBy, range, actor),
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
    const bookings = occurrences.map((occ) => {
      const booking = this.buildBooking(resource, bookedBy, occ, actor);
      booking.seriesId = seriesId;
      return this.store.addBooking(booking);
    });

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
    this.bus.publish({ type: "booking.cancelled", booking: cancelled }, actor);
    return cancelled;
  }

  listBookings(resourceId?: string): Booking[] {
    if (resourceId) {
      return this.store.bookingsForResource(resourceId);
    }
    return this.store.listBookings();
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
    };
  }
}
