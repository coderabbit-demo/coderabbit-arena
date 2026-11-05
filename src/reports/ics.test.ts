import { describe, expect, it } from "vitest";
import { bookingsToIcs } from "./ics";
import { Booking, Resource } from "../domain/types";

const resource: Resource = { id: "r1", name: "Room A", capacity: 1, createdBy: "k1" };

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "b1",
    resourceId: "r1",
    bookedBy: "Ada",
    start: "2026-08-01T09:00:00.000Z",
    end: "2026-08-01T10:00:00.000Z",
    status: "confirmed",
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "k1",
    ...overrides,
  };
}

describe("bookingsToIcs", () => {
  it("wraps events in a VCALENDAR", () => {
    const ics = bookingsToIcs(resource, [booking()]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20260801T090000Z");
    expect(ics).toContain("SUMMARY:Room A — Ada");
  });

  it("skips cancelled bookings", () => {
    const ics = bookingsToIcs(resource, [booking({ status: "cancelled" })]);
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("uses CRLF line endings", () => {
    const ics = bookingsToIcs(resource, []);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  });
});
