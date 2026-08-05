import { describe, expect, it, beforeEach } from "vitest";
import { BookingService, ConflictError, NotFoundError } from "./bookingService";
import { InMemoryStore } from "../store/store";
import { ValidationError } from "../domain/time";

function setup() {
  const store = new InMemoryStore();
  const service = new BookingService(store);
  const room = service.createResource({ name: "Room A" });
  return { store, service, room };
}

describe("createBooking", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("confirms a booking on a free resource", () => {
    const booking = ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    });
    expect(booking.status).toBe("confirmed");
  });

  it("rejects overlapping bookings on a capacity-1 resource", () => {
    ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    });
    expect(() =>
      ctx.service.createBooking({
        resourceId: ctx.room.id,
        bookedBy: "Grace",
        start: "2026-08-01T09:30:00.000Z",
        end: "2026-08-01T10:30:00.000Z",
      }),
    ).toThrow(ConflictError);
  });

  it("allows back-to-back bookings", () => {
    ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    });
    const second = ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Grace",
      start: "2026-08-01T10:00:00.000Z",
      end: "2026-08-01T11:00:00.000Z",
    });
    expect(second.status).toBe("confirmed");
  });

  it("frees a slot after cancellation", () => {
    const first = ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    });
    ctx.service.cancelBooking(first.id);
    const second = ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Grace",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    });
    expect(second.status).toBe("confirmed");
  });

  it("rejects an unknown resource", () => {
    expect(() =>
      ctx.service.createBooking({
        resourceId: "nope",
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      }),
    ).toThrow(NotFoundError);
  });

  it("rejects an inverted time range", () => {
    expect(() =>
      ctx.service.createBooking({
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T10:00:00.000Z",
        end: "2026-08-01T09:00:00.000Z",
      }),
    ).toThrow(ValidationError);
  });
});

describe("createRecurringBooking", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("creates one booking per occurrence with a shared seriesId", () => {
    const result = ctx.service.createRecurringBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-03T09:00:00.000Z",
      end: "2026-08-03T10:00:00.000Z",
      rule: { frequency: "daily", interval: 1, count: 3 },
    });

    expect(result.bookings).toHaveLength(3);
    expect(new Set(result.bookings.map((b) => b.seriesId))).toEqual(
      new Set([result.seriesId]),
    );
    expect(result.bookings.every((b) => b.status === "confirmed")).toBe(true);
  });

  it("persists every occurrence to the store", () => {
    ctx.service.createRecurringBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-03T09:00:00.000Z",
      end: "2026-08-03T10:00:00.000Z",
      rule: { frequency: "weekly", interval: 1, count: 2 },
    });

    expect(ctx.service.listBookings(ctx.room.id)).toHaveLength(2);
  });

  it("rejects the whole series when one occurrence conflicts", () => {
    ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Grace",
      start: "2026-08-04T09:00:00.000Z",
      end: "2026-08-04T10:00:00.000Z",
    });

    expect(() =>
      ctx.service.createRecurringBooking({
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-03T09:00:00.000Z",
        end: "2026-08-03T10:00:00.000Z",
        rule: { frequency: "daily", interval: 1, count: 3 },
      }),
    ).toThrow(ConflictError);

    // Nothing from the series should have been persisted.
    expect(ctx.service.listBookings(ctx.room.id)).toHaveLength(1);
  });

  it("rejects a series that overlaps itself on a capacity-1 resource", () => {
    // A 25-hour duration repeated daily overlaps the next occurrence.
    expect(() =>
      ctx.service.createRecurringBooking({
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-03T09:00:00.000Z",
        end: "2026-08-04T10:00:00.000Z",
        rule: { frequency: "daily", interval: 1, count: 2 },
      }),
    ).toThrow(ConflictError);
  });
});
