import { overlaps } from "./time";
import { Booking, TimeRange } from "./types";

/** A candidate slot within a requested window. */
export interface Slot {
  start: string;
  end: string;
}

/**
 * Generate consecutive fixed-length slots that tile the window
 * [windowStart, windowEnd). A trailing partial slot that would exceed the
 * window is discarded.
 */
export function generateSlots(
  window: TimeRange,
  slotMinutes: number,
): TimeRange[] {
  if (!Number.isFinite(slotMinutes) || slotMinutes <= 0) {
    throw new Error("slotMinutes must be a positive number");
  }

  const slotMs = slotMinutes * 60 * 1000;
  const slots: TimeRange[] = [];

  let cursor = window.start.getTime();
  const end = window.end.getTime();

  while (cursor + slotMs <= end) {
    slots.push({
      start: new Date(cursor),
      end: new Date(cursor + slotMs),
    });
    cursor += slotMs;
  }

  return slots;
}

/**
 * Return the slots in the window that are still bookable, taking the resource
 * capacity and its confirmed bookings into account. A slot is free when the
 * number of confirmed bookings overlapping it is below capacity.
 */
export function freeSlots(
  window: TimeRange,
  slotMinutes: number,
  capacity: number,
  confirmed: TimeRange[],
): Slot[] {
  const slots = generateSlots(window, slotMinutes);

  return slots
    .filter((slot) => {
      const concurrent = confirmed.filter((b) => overlaps(slot, b)).length;
      return concurrent < capacity;
    })
    .map((slot) => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
    }));
}

/** Convert stored bookings into time ranges for availability math. */
export function toRanges(bookings: Booking[]): TimeRange[] {
  return bookings.map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}
