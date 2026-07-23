import { describe, expect, it } from "vitest";
import { freeSlots, generateSlots, toRanges } from "./availability";
import { parseRange } from "./time";

const window = parseRange(
  "2026-08-01T09:00:00.000Z",
  "2026-08-01T12:00:00.000Z",
);

describe("generateSlots", () => {
  it("tiles the window into fixed-length slots", () => {
    const slots = generateSlots(window, 60);
    expect(slots).toHaveLength(3);
    expect(slots[0].start.toISOString()).toBe("2026-08-01T09:00:00.000Z");
    expect(slots[2].end.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("discards a trailing partial slot", () => {
    const slots = generateSlots(window, 120);
    expect(slots).toHaveLength(1);
    expect(slots[0].end.toISOString()).toBe("2026-08-01T11:00:00.000Z");
  });

  it("rejects non-positive slot lengths", () => {
    expect(() => generateSlots(window, 0)).toThrow();
    expect(() => generateSlots(window, -30)).toThrow();
  });
});

describe("freeSlots", () => {
  it("returns every slot when there are no bookings", () => {
    const slots = freeSlots(window, 60, 1, []);
    expect(slots).toHaveLength(3);
  });

  it("removes slots that overlap a confirmed booking on a capacity-1 resource", () => {
    const booked = toRanges([
      {
        id: "b1",
        resourceId: "r1",
        bookedBy: "Ada",
        start: "2026-08-01T10:00:00.000Z",
        end: "2026-08-01T11:00:00.000Z",
        status: "confirmed",
        createdAt: "2026-07-23T00:00:00.000Z",
      },
    ]);
    const slots = freeSlots(window, 60, 1, booked);
    expect(slots.map((s) => s.start)).toEqual([
      "2026-08-01T09:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
    ]);
  });

  it("keeps a slot while capacity is not exhausted", () => {
    const booked = toRanges([
      {
        id: "b1",
        resourceId: "r1",
        bookedBy: "Ada",
        start: "2026-08-01T10:00:00.000Z",
        end: "2026-08-01T11:00:00.000Z",
        status: "confirmed",
        createdAt: "2026-07-23T00:00:00.000Z",
      },
    ]);
    const slots = freeSlots(window, 60, 2, booked);
    expect(slots).toHaveLength(3);
  });
});
