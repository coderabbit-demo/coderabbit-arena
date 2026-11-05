/** A bookable resource, e.g. a meeting room or a piece of equipment. */
export interface Resource {
  id: string;
  name: string;
  /** Maximum concurrent bookings this resource supports (usually 1). */
  capacity: number;
  /** Id of the API key that created the resource. */
  createdBy: string;
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
  /** Id of the API key that created the booking. */
  createdBy: string;
  /** Set when the booking was cancelled (ISO-8601). */
  cancelledAt?: string;
  /** Id of the API key that cancelled the booking. */
  cancelledBy?: string;
  /** Present when this booking is part of a recurring series. */
  seriesId?: string;
  /**
   * Private bookings (1:1s, interviews, HR meetings) are only listed to the
   * key that created them and to keys holding `bookings:read:private`.
   */
  private?: boolean;
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
  /** Hide the booking from other keys' listings. Defaults to false. */
  private?: boolean;
}

/** A closed-open time interval used for availability math. */
export interface TimeRange {
  start: Date;
  end: Date;
}
