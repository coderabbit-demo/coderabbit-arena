import { TimeRange } from "./types";

/**
 * Parse and validate a booking interval from ISO strings.
 * Throws a ValidationError if either bound is invalid or the range is empty.
 */
export function parseRange(startIso: string, endIso: string): TimeRange {
  const start = new Date(startIso);
  const end = new Date(endIso);

  if (Number.isNaN(start.getTime())) {
    throw new ValidationError(`Invalid start timestamp: ${startIso}`);
  }
  if (Number.isNaN(end.getTime())) {
    throw new ValidationError(`Invalid end timestamp: ${endIso}`);
  }
  if (end.getTime() <= start.getTime()) {
    throw new ValidationError("Booking end must be after start");
  }

  return { start, end };
}

/**
 * Two half-open intervals [aStart, aEnd) and [bStart, bEnd) overlap when each
 * starts strictly before the other ends. Back-to-back bookings (a.end === b.start)
 * do not overlap.
 */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
