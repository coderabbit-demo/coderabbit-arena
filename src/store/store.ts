import { Booking, Resource } from "../domain/types";

/**
 * Simple in-memory store. Swap this out for a database-backed implementation
 * without touching the service layer.
 */
export class InMemoryStore {
  private resources = new Map<string, Resource>();
  private bookings = new Map<string, Booking>();

  addResource(resource: Resource): Resource {
    this.resources.set(resource.id, resource);
    return resource;
  }

  getResource(id: string): Resource | undefined {
    return this.resources.get(id);
  }

  listResources(): Resource[] {
    return [...this.resources.values()];
  }

  addBooking(booking: Booking): Booking {
    this.bookings.set(booking.id, booking);
    return booking;
  }

  getBooking(id: string): Booking | undefined {
    return this.bookings.get(id);
  }

  updateBooking(booking: Booking): Booking {
    this.bookings.set(booking.id, booking);
    return booking;
  }

  /** All bookings for a resource, optionally filtered to confirmed ones. */
  bookingsForResource(resourceId: string, confirmedOnly = false): Booking[] {
    return [...this.bookings.values()].filter(
      (b) =>
        b.resourceId === resourceId &&
        (!confirmedOnly || b.status === "confirmed"),
    );
  }

  listBookings(): Booking[] {
    return [...this.bookings.values()];
  }
}
