import { ValidationError } from "../domain/time";
import { Booking, Resource } from "../domain/types";

/** Bookable hours, in UTC. */
export const OPEN_FROM_HOUR = 8;
export const OPEN_UNTIL_HOUR = 18;
export const SLOT_MINUTES = [15, 30, 60] as const;

export interface Slot {
  start: string;
  end: string;
  /** True while at least one more booking fits in this slot. */
  available: boolean;
  /** How many more bookings fit, from 0 up to the resource's capacity. */
  remaining: number;
}

export interface Availability {
  resourceId: string;
  date: string;
  timeZone: "UTC";
  slotMinutes: number;
  slots: Slot[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_MS = 60 * 1000;

function parseDay(date: string): number {
  if (!DATE_PATTERN.test(date)) {
    throw new ValidationError("date must look like YYYY-MM-DD");
  }
  const day = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(day) || new Date(day).toISOString().slice(0, 10) !== date) {
    throw new ValidationError(`Invalid date: ${date}`);
  }
  return day;
}

/**
 * Split a day's opening hours into slots and work out how many more bookings
 * each slot can take, given the resource's confirmed bookings.
 */
export function availabilityFor(
  resource: Resource,
  bookings: Booking[],
  date: string,
  slotMinutes = 30,
): Availability {
  if (!(SLOT_MINUTES as readonly number[]).includes(slotMinutes)) {
    throw new ValidationError(`slotMinutes must be one of ${SLOT_MINUTES.join(", ")}`);
  }
  const day = parseDay(date);
  const confirmed = bookings
    .filter((b) => b.resourceId === resource.id && b.status === "confirmed")
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));

  const slots: Slot[] = [];
  const open = day + OPEN_FROM_HOUR * 60 * MINUTE_MS;
  const close = day + OPEN_UNTIL_HOUR * 60 * MINUTE_MS;
  for (let start = open; start < close; start += slotMinutes * MINUTE_MS) {
    const end = start + slotMinutes * MINUTE_MS;
    const taken = confirmed.filter((b) => start <= b.end && b.start <= end).length;
    const remaining = Math.max(resource.capacity - taken, 0);
    slots.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      available: remaining > 0,
      remaining,
    });
  }

  return { resourceId: resource.id, date, timeZone: "UTC", slotMinutes, slots };
}
