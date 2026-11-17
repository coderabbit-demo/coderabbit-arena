import { describe, expect, it } from "vitest";
import { ValidationError } from "../domain/time";
import { Booking, Resource } from "../domain/types";
import { availabilityFor } from "./availability";

const room = { id: "r1", name: "Atlas", capacity: 1 } as Resource;
const kit = { id: "r2", name: "Projector kit", capacity: 2 } as Resource;

function booking(resourceId: string, start: string, end: string, status = "confirmed"): Booking {
  return {
    id: `${resourceId}-${start}`,
    resourceId,
    bookedBy: "Ada Lovelace",
    start: `2026-11-18T${start}:00.000Z`,
    end: `2026-11-18T${end}:00.000Z`,
    status,
    private: false,
  } as Booking;
}

describe("availabilityFor", () => {
  it("splits 08:00–18:00 UTC into free 30-minute slots by default", () => {
    const result = availabilityFor(room, [], "2026-11-18");
    expect(result.slotMinutes).toBe(30);
    expect(result.slots).toHaveLength(20);
    expect(result.slots[0]).toEqual({
      start: "2026-11-18T08:00:00.000Z",
      end: "2026-11-18T08:30:00.000Z",
      available: true,
      remaining: 1,
    });
    expect(result.slots[19].end).toBe("2026-11-18T18:00:00.000Z");
  });

  it("supports hour-long slots", () => {
    expect(availabilityFor(room, [], "2026-11-18", 60).slots).toHaveLength(10);
  });

  it("marks the slots a booking covers as taken", () => {
    const result = availabilityFor(room, [booking("r1", "09:00", "10:00")], "2026-11-18");
    const taken = result.slots.filter((s) => !s.available).map((s) => s.start.slice(11, 16));
    expect(taken).toContain("09:00");
    expect(taken).toContain("09:30");
  });

  it("ignores cancelled bookings and other resources", () => {
    const result = availabilityFor(
      room,
      [booking("r1", "11:00", "12:00", "cancelled"), booking("r2", "11:00", "12:00")],
      "2026-11-18",
    );
    expect(result.slots.every((s) => s.available)).toBe(true);
  });

  it("counts remaining capacity for shared resources", () => {
    const result = availabilityFor(kit, [booking("r2", "14:00", "15:00")], "2026-11-18");
    const slot = result.slots.find((s) => s.start.endsWith("T14:00:00.000Z"));
    expect(slot).toMatchObject({ available: true, remaining: 1 });
  });

  it("rejects malformed dates and slot sizes", () => {
    expect(() => availabilityFor(room, [], "18/11/2026")).toThrow(ValidationError);
    expect(() => availabilityFor(room, [], "2026-02-30")).toThrow(ValidationError);
    expect(() => availabilityFor(room, [], "2026-11-18", 7)).toThrow(ValidationError);
  });
});
