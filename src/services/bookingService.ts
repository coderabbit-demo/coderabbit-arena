import { randomUUID } from "crypto";
import { InMemoryStore } from "../store/store";
import { overlaps, parseRange, ValidationError } from "../domain/time";
import { freeSlots, Slot, toRanges } from "../domain/availability";
import {
  Booking,
  CreateBookingInput,
  CreateResourceInput,
  Resource,
} from "../domain/types";

export interface AvailabilityQuery {
  resourceId: string;
  start: string;
  end: string;
  slotMinutes: number;
}

export interface RescheduleInput {
  start: string;
  end: string;
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

    const concurrent = this.store
      .bookingsForResource(resource.id, true)
      .filter((existing) =>
        overlaps(range, parseRange(existing.start, existing.end)),
      );

    if (concurrent.length >= resource.capacity) {
      throw new ConflictError(
        `Resource "${resource.name}" is fully booked for the requested time`,
      );
    }

    const booking: Booking = {
      id: randomUUID(),
      resourceId: resource.id,
      bookedBy,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      status: "confirmed",
      createdAt: new Date().toISOString(),
    };

    return this.store.addBooking(booking);
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
   * Compute the bookable slots for a resource within a window, tiled at a
   * fixed slot length and filtered against confirmed bookings and capacity.
   */
  getAvailability(query: AvailabilityQuery): Slot[] {
    const resource = this.store.getResource(query.resourceId);
    if (!resource) {
      throw new NotFoundError(`Resource not found: ${query.resourceId}`);
    }

    if (!Number.isInteger(query.slotMinutes) || query.slotMinutes <= 0) {
      throw new ValidationError("slotMinutes must be a positive integer");
    }

    const window = parseRange(query.start, query.end);
    const confirmed = toRanges(
      this.store.bookingsForResource(resource.id, true),
    );

    return freeSlots(window, query.slotMinutes, resource.capacity, confirmed);
  }

  /**
   * Move a confirmed booking to a new time range. The booking's own current
   * slot is ignored when checking for conflicts so a no-op reschedule succeeds.
   */
  rescheduleBooking(id: string, input: RescheduleInput): Booking {
    const booking = this.store.getBooking(id);
    if (!booking) {
      throw new NotFoundError(`Booking not found: ${id}`);
    }
    if (booking.status === "cancelled") {
      throw new ConflictError("Cannot reschedule a cancelled booking");
    }

    const resource = this.store.getResource(booking.resourceId);
    if (!resource) {
      throw new NotFoundError(`Resource not found: ${booking.resourceId}`);
    }

    const range = parseRange(input.start, input.end);

    const concurrent = this.store
      .bookingsForResource(resource.id, true)
      .filter((existing) => existing.id !== booking.id)
      .filter((existing) =>
        overlaps(range, parseRange(existing.start, existing.end)),
      );

    if (concurrent.length >= resource.capacity) {
      throw new ConflictError(
        `Resource "${resource.name}" is fully booked for the requested time`,
      );
    }

    return this.store.updateBooking({
      ...booking,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    });
  }
}
