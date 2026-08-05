import { randomUUID } from "crypto";
import { InMemoryStore } from "../store/store";
import { overlaps, parseRange, ValidationError } from "../domain/time";
import {
  Booking,
  CreateBookingInput,
  CreateResourceInput,
  Resource,
  TimeRange,
} from "../domain/types";
import { expand } from "../recurrence/recurrence";
import { Occurrence, RecurrenceRule } from "../recurrence/types";

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

export class BookingService {
  constructor(private readonly store: InMemoryStore) {}

  createResource(input: CreateResourceInput): Resource {
    const name = input.name?.trim();
    if (!name) {
      throw new ValidationError("Resource name is required");
    }
    const capacity = input.capacity ?? 1;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new ValidationError("Capacity must be a positive integer");
    }

    return this.store.addResource({
      id: randomUUID(),
      name,
      capacity,
    });
  }

  listResources(): Resource[] {
    return this.store.listResources();
  }

  createBooking(input: CreateBookingInput): Booking {
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

    const booking = this.buildBooking(resource, bookedBy, range);
    return this.store.addBooking(booking);
  }

  /**
   * Create a whole series of bookings from a recurrence rule. Every occurrence
   * is checked for conflicts before anything is persisted, so a single clash
   * rejects the entire series (all-or-nothing).
   */
  createRecurringBooking(
    input: CreateRecurringBookingInput,
  ): RecurringBookingResult {
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
      const booking = this.buildBooking(resource, bookedBy, occ);
      booking.seriesId = seriesId;
      return this.store.addBooking(booking);
    });

    return { seriesId, bookings };
  }

  cancelBooking(id: string): Booking {
    const booking = this.store.getBooking(id);
    if (!booking) {
      throw new NotFoundError(`Booking not found: ${id}`);
    }
    if (booking.status === "cancelled") {
      return booking;
    }
    return this.store.updateBooking({ ...booking, status: "cancelled" });
  }

  listBookings(resourceId?: string): Booking[] {
    if (resourceId) {
      return this.store.bookingsForResource(resourceId);
    }
    return this.store.listBookings();
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
  ): Booking {
    return {
      id: randomUUID(),
      resourceId: resource.id,
      bookedBy,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      status: "confirmed",
      createdAt: new Date().toISOString(),
    };
  }
}
