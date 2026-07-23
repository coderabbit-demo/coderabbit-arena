import { describe, expect, it, beforeEach } from "vitest";
import { BookingService, ConflictError, NotFoundError } from "./bookingService";
import { InMemoryStore } from "../store/store";

function setup() {
  const store = new InMemoryStore();
  const service = new BookingService(store);
  const room = service.createResource({ name: "Room A" });
  const booking = service.createBooking({
    resourceId: room.id,
    bookedBy: "Ada",
    start: "2026-08-01T09:00:00.000Z",
    end: "2026-08-01T10:00:00.000Z",
  });
  return { store, service, room, booking };
}

describe("rescheduleBooking", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("moves a booking to a free time range", () => {
    const moved = ctx.service.rescheduleBooking(ctx.booking.id, {
      start: "2026-08-01T14:00:00.000Z",
      end: "2026-08-01T15:00:00.000Z",
    });
    expect(moved.start).toBe("2026-08-01T14:00:00.000Z");
    expect(moved.status).toBe("confirmed");
  });

  it("allows a no-op reschedule to the same range", () => {
    const moved = ctx.service.rescheduleBooking(ctx.booking.id, {
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    });
    expect(moved.start).toBe("2026-08-01T09:00:00.000Z");
  });

  it("rejects a move that collides with another booking", () => {
    ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Grace",
      start: "2026-08-01T11:00:00.000Z",
      end: "2026-08-01T12:00:00.000Z",
    });
    expect(() =>
      ctx.service.rescheduleBooking(ctx.booking.id, {
        start: "2026-08-01T11:30:00.000Z",
        end: "2026-08-01T12:30:00.000Z",
      }),
    ).toThrow(ConflictError);
  });

  it("rejects rescheduling an unknown booking", () => {
    expect(() =>
      ctx.service.rescheduleBooking("nope", {
        start: "2026-08-01T14:00:00.000Z",
        end: "2026-08-01T15:00:00.000Z",
      }),
    ).toThrow(NotFoundError);
  });

  it("rejects rescheduling a cancelled booking", () => {
    ctx.service.cancelBooking(ctx.booking.id);
    expect(() =>
      ctx.service.rescheduleBooking(ctx.booking.id, {
        start: "2026-08-01T14:00:00.000Z",
        end: "2026-08-01T15:00:00.000Z",
      }),
    ).toThrow(ConflictError);
  });
});

describe("getAvailability", () => {
  it("returns bookable slots around an existing booking", () => {
    const { service, room } = setup();
    const slots = service.getAvailability({
      resourceId: room.id,
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T12:00:00.000Z",
      slotMinutes: 60,
    });
    // 09-10 is booked in setup(), so 10-11 and 11-12 remain.
    expect(slots.map((s) => s.start)).toEqual([
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
    ]);
  });

  it("rejects a non-positive slot length", () => {
    const { service, room } = setup();
    expect(() =>
      service.getAvailability({
        resourceId: room.id,
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T12:00:00.000Z",
        slotMinutes: 0,
      }),
    ).toThrow();
  });
});
