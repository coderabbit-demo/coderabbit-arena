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
