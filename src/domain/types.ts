/** A bookable resource, e.g. a meeting room or a piece of equipment. */
export interface Resource {
  id: string;
  name: string;
  /** Maximum concurrent bookings this resource supports (usually 1). */
  capacity: number;
}

export type BookingStatus = "confirmed" | "cancelled";

/** A reservation of a resource over a half-open time interval [start, end). */
export interface Booking {
  id: string;
  resourceId: string;
  /** Human-readable name of whoever made the booking. */
  bookedBy: string;
  /** ISO-8601 timestamp (inclusive). */
  start: string;
  /** ISO-8601 timestamp (exclusive). */
  end: string;
  status: BookingStatus;
  createdAt: string;
}

export interface CreateResourceInput {
  name: string;
  capacity?: number;
}

export interface CreateBookingInput {
  resourceId: string;
  bookedBy: string;
  start: string;
  end: string;
}

/** A closed-open time interval used for availability math. */
export interface TimeRange {
  start: Date;
  end: Date;
}
