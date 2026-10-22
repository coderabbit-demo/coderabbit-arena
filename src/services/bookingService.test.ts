import { describe, expect, it, beforeEach } from "vitest";
import { BookingService, ConflictError, NotFoundError } from "./bookingService";
import { InMemoryStore } from "../store/store";
import { ValidationError } from "../domain/time";
import { Actor, ForbiddenError } from "../auth/types";
import { EventBus } from "../events/bus";
import { EventEnvelope } from "../events/types";

const admin: Actor = { keyId: "key-admin", name: "Admin", role: "admin" };
const member: Actor = { keyId: "key-member", name: "Member", role: "member" };
const otherMember: Actor = { keyId: "key-other", name: "Other", role: "member" };
const viewer: Actor = { keyId: "key-viewer", name: "Viewer", role: "viewer" };

function setup() {
  const store = new InMemoryStore();
  const bus = new EventBus();
  const published: EventEnvelope[] = [];
  bus.subscribe("*", (e) => published.push(e));
  const service = new BookingService(store, bus);
  const room = service.createResource({ name: "Room A" }, admin);
  return { store, service, room, bus, published };
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
    }, admin);
    expect(booking.status).toBe("confirmed");
  });

  it("rejects overlapping bookings on a capacity-1 resource", () => {
    ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    }, admin);
    expect(() =>
      ctx.service.createBooking({
        resourceId: ctx.room.id,
        bookedBy: "Grace",
        start: "2026-08-01T09:30:00.000Z",
        end: "2026-08-01T10:30:00.000Z",
      }, admin),
    ).toThrow(ConflictError);
  });

  it("allows back-to-back bookings", () => {
    ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    }, admin);
    const second = ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Grace",
      start: "2026-08-01T10:00:00.000Z",
      end: "2026-08-01T11:00:00.000Z",
    }, admin);
    expect(second.status).toBe("confirmed");
  });

  it("frees a slot after cancellation", () => {
    const first = ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Ada",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    }, admin);
    ctx.service.cancelBooking(first.id, admin);
    const second = ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Grace",
      start: "2026-08-01T09:00:00.000Z",
      end: "2026-08-01T10:00:00.000Z",
    }, admin);
    expect(second.status).toBe("confirmed");
  });

  it("rejects an unknown resource", () => {
    expect(() =>
      ctx.service.createBooking({
        resourceId: "nope",
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      }, admin),
    ).toThrow(NotFoundError);
  });

  it("rejects an inverted time range", () => {
    expect(() =>
      ctx.service.createBooking({
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T10:00:00.000Z",
        end: "2026-08-01T09:00:00.000Z",
      }, admin),
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
    }, admin);

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
    }, admin);

    expect(ctx.service.listBookings(ctx.room.id)).toHaveLength(2);
  });

  it("rejects the whole series when one occurrence conflicts", () => {
    ctx.service.createBooking({
      resourceId: ctx.room.id,
      bookedBy: "Grace",
      start: "2026-08-04T09:00:00.000Z",
      end: "2026-08-04T10:00:00.000Z",
    }, admin);

    expect(() =>
      ctx.service.createRecurringBooking({
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-03T09:00:00.000Z",
        end: "2026-08-03T10:00:00.000Z",
        rule: { frequency: "daily", interval: 1, count: 3 },
      }, admin),
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
      }, admin),
    ).toThrow(ConflictError);
  });
});

describe("authorization", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("stamps the creating key on bookings", () => {
    const booking = ctx.service.createBooking(
      {
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      },
      member,
    );
    expect(booking.createdBy).toBe(member.keyId);
  });

  it("rejects viewers creating bookings", () => {
    expect(() =>
      ctx.service.createBooking(
        {
          resourceId: ctx.room.id,
          bookedBy: "Ada",
          start: "2026-08-01T09:00:00.000Z",
          end: "2026-08-01T10:00:00.000Z",
        },
        viewer,
      ),
    ).toThrow(ForbiddenError);
  });

  it("rejects members creating resources", () => {
    expect(() => ctx.service.createResource({ name: "Room B" }, member)).toThrow(
      ForbiddenError,
    );
  });

  it("lets a member cancel their own booking", () => {
    const booking = ctx.service.createBooking(
      {
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      },
      member,
    );
    const cancelled = ctx.service.cancelBooking(booking.id, member);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledBy).toBe(member.keyId);
    expect(cancelled.cancelledAt).toBeDefined();
  });

  it("stops a member cancelling someone else's booking", () => {
    const booking = ctx.service.createBooking(
      {
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      },
      member,
    );
    expect(() => ctx.service.cancelBooking(booking.id, otherMember)).toThrow(
      ForbiddenError,
    );
    expect(ctx.store.getBooking(booking.id)?.status).toBe("confirmed");
  });

  it("lets an admin cancel anyone's booking", () => {
    const booking = ctx.service.createBooking(
      {
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      },
      member,
    );
    expect(ctx.service.cancelBooking(booking.id, admin).status).toBe("cancelled");
  });
});

describe("events", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
    ctx.published.length = 0;
  });

  it("publishes booking.created with the acting key", () => {
    const booking = ctx.service.createBooking(
      {
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      },
      member,
    );
    expect(ctx.published).toHaveLength(1);
    const [envelope] = ctx.published;
    expect(envelope.event.type).toBe("booking.created");
    expect(envelope.actor).toEqual(member);
    if (envelope.event.type === "booking.created") {
      expect(envelope.event.booking.id).toBe(booking.id);
    }
  });

  it("publishes a single series event for recurring bookings", () => {
    const result = ctx.service.createRecurringBooking(
      {
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-03T09:00:00.000Z",
        end: "2026-08-03T10:00:00.000Z",
        rule: { frequency: "daily", interval: 1, count: 3 },
      },
      admin,
    );
    expect(ctx.published.map((e) => e.event.type)).toEqual(["booking.series.created"]);
    const event = ctx.published[0].event;
    if (event.type === "booking.series.created") {
      expect(event.seriesId).toBe(result.seriesId);
      expect(event.bookings).toHaveLength(3);
    }
  });

  it("does not publish anything when a mutation is rejected", () => {
    expect(() =>
      ctx.service.createBooking(
        {
          resourceId: "missing",
          bookedBy: "Ada",
          start: "2026-08-01T09:00:00.000Z",
          end: "2026-08-01T10:00:00.000Z",
        },
        admin,
      ),
    ).toThrow(NotFoundError);
    expect(ctx.published).toHaveLength(0);
  });

  it("publishes booking.cancelled exactly once even if cancelled twice", () => {
    const booking = ctx.service.createBooking(
      {
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      },
      admin,
    );
    ctx.service.cancelBooking(booking.id, admin);
    ctx.service.cancelBooking(booking.id, admin);
    expect(ctx.published.filter((e) => e.event.type === "booking.cancelled")).toHaveLength(1);
  });
});

describe("listBookingsPage", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
    // Created out of order so the page order has to come from sorting.
    for (const day of [3, 1, 4, 2, 5]) {
      ctx.service.createBooking(
        {
          resourceId: ctx.room.id,
          bookedBy: `Day ${day}`,
          start: `2026-08-0${day}T09:00:00.000Z`,
          end: `2026-08-0${day}T10:00:00.000Z`,
        },
        admin,
      );
    }
  });

  it("walks every booking in start order without gaps or duplicates", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = ctx.service.listBookingsPage({ resourceId: ctx.room.id, limit: 2, cursor });
      seen.push(...result.data.map((b) => b.bookedBy));
      if (!result.nextCursor) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(["Day 1", "Day 2", "Day 3", "Day 4", "Day 5"]);
  });

  it("returns a null cursor on the last page", () => {
    const page = ctx.service.listBookingsPage({ limit: 5 });
    expect(page.data).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("rejects bad limits and cursors", () => {
    expect(() => ctx.service.listBookingsPage({ limit: 0 })).toThrow(ValidationError);
    expect(() => ctx.service.listBookingsPage({ limit: 201 })).toThrow(ValidationError);
    expect(() => ctx.service.listBookingsPage({ cursor: "not-a-cursor" })).toThrow(/Invalid cursor/);
  });
});

describe("booking.cancelled event", () => {
  it("carries identifiers only, not the booking itself", () => {
    const ctx = setup();
    const booking = ctx.service.createBooking(
      {
        resourceId: ctx.room.id,
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      },
      member,
    );
    const cancelled = ctx.service.cancelBooking(booking.id, member);
    const event = ctx.published.find((e) => e.event.type === "booking.cancelled")?.event;
    expect(event).toEqual({
      type: "booking.cancelled",
      bookingId: booking.id,
      resourceId: ctx.room.id,
      cancelledAt: cancelled.cancelledAt,
      cancelledBy: member.keyId,
    });
  });
});
