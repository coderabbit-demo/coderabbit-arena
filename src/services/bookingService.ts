import { randomUUID } from "crypto";
import { InMemoryStore } from "../store/store";
import { overlaps, parseRange, ValidationError } from "../domain/time";
import {
  Booking,
  CreateBookingInput,
  CreateResourceInput,
  Resource,
} from "../domain/types";
import { buildUtilizationReport } from "../reports/reports";
import { ReportInput, UtilizationReport } from "../reports/types";

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
}
