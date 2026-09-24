import { beforeEach, describe, expect, it } from "vitest";
import { AuditLog, summarize } from "./audit";
import { EventBus } from "../events/bus";
import { InMemoryStore } from "../store/store";
import { Actor } from "../auth/types";
import { Booking, Resource } from "../domain/types";

const admin: Actor = { keyId: "k-admin", name: "Admin", role: "admin" };
const member: Actor = { keyId: "k-member", name: "Member", role: "member" };

const room: Resource = { id: "r1", name: "Room A", capacity: 2, createdBy: "k-admin" };
const booking: Booking = {
  id: "b1",
  resourceId: "r1",
  bookedBy: "Ada",
  start: "2026-08-01T09:00:00.000Z",
  end: "2026-08-01T10:00:00.000Z",
  status: "confirmed",
  createdAt: "2026-07-01T00:00:00.000Z",
  createdBy: "k-member",
};

describe("summarize", () => {
  it("describes resource creation", () => {
    expect(summarize({ type: "resource.created", resource: room })).toEqual({
      subjectType: "resource",
      subjectId: "r1",
      details: { name: "Room A", capacity: 2 },
    });
  });

  it("describes booking creation without leaking unrelated fields", () => {
    const s = summarize({ type: "booking.created", booking });
    expect(s.subjectType).toBe("booking");
    expect(s.subjectId).toBe("b1");
    expect(s.details).toEqual({
      resourceId: "r1",
      bookedBy: "Ada",
      start: booking.start,
      end: booking.end,
    });
  });

  it("describes a series by its member ids", () => {
    const s = summarize({
      type: "booking.series.created",
      seriesId: "s1",
      bookings: [booking, { ...booking, id: "b2" }],
    });
    expect(s.subjectId).toBe("s1");
    expect(s.details).toEqual({ count: 2, resourceId: "r1", bookingIds: ["b1", "b2"] });
  });

  it("handles an empty series", () => {
    const s = summarize({ type: "booking.series.created", seriesId: "s1", bookings: [] });
    expect(s.details).toEqual({ count: 0, resourceId: null, bookingIds: [] });
  });

  it("describes cancellation", () => {
    const s = summarize({
      type: "booking.cancelled",
      booking: { ...booking, status: "cancelled", cancelledAt: "2026-07-02T00:00:00.000Z" },
    });
    expect(s.details).toEqual({ resourceId: "r1", cancelledAt: "2026-07-02T00:00:00.000Z" });
  });

  it("describes key and webhook lifecycle events", () => {
    expect(summarize({ type: "apikey.issued", keyId: "k2", role: "viewer" })).toEqual({
      subjectType: "apikey",
      subjectId: "k2",
      details: { role: "viewer" },
    });
    expect(summarize({ type: "apikey.revoked", keyId: "k2" }).details).toEqual({});
    expect(
      summarize({ type: "apikey.rotated", keyId: "k2", graceUntil: "2026-09-02T00:00:00.000Z" }),
    ).toEqual({
      subjectType: "apikey",
      subjectId: "k2",
      details: { graceUntil: "2026-09-02T00:00:00.000Z" },
    });
    expect(
      summarize({ type: "webhook.registered", webhookId: "w1", url: "https://x.test/h" }).details,
    ).toEqual({ url: "https://x.test/h" });
    expect(summarize({ type: "webhook.removed", webhookId: "w1" }).subjectType).toBe("webhook");
  });
});

describe("AuditLog", () => {
  let store: InMemoryStore;
  let bus: EventBus;
  let log: AuditLog;
  let tick: number;

  beforeEach(() => {
    store = new InMemoryStore();
    tick = 0;
    bus = new EventBus(undefined, () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    log = new AuditLog(store, bus);
  });

  it("records every published event", () => {
    bus.publish({ type: "resource.created", resource: room }, admin);
    bus.publish({ type: "booking.created", booking }, member);

    const page = log.query();
    expect(page.total).toBe(2);
    expect(page.entries.map((e) => e.action)).toEqual(["booking.created", "resource.created"]);
    expect(page.entries[0].actorKeyId).toBe("k-member");
    expect(page.entries[0].actorName).toBe("Member");
  });

  it("records system actions with a null actor", () => {
    bus.publish({ type: "apikey.issued", keyId: "k0", role: "admin" }, null);
    const [entry] = log.query().entries;
    expect(entry.actorKeyId).toBeNull();
    expect(entry.actorName).toBeNull();
  });

  it("filters by action, actor and subject", () => {
    bus.publish({ type: "resource.created", resource: room }, admin);
    bus.publish({ type: "booking.created", booking }, member);
    bus.publish({ type: "booking.cancelled", booking }, admin);

    expect(log.query({ action: "booking.created" }).total).toBe(1);
    expect(log.query({ actorKeyId: "k-admin" }).total).toBe(2);
    expect(log.query({ subjectId: "b1" }).total).toBe(2);
    expect(log.query({ subjectId: "b1", actorKeyId: "k-member" }).total).toBe(1);
  });

  it("filters by time window (inclusive from, exclusive to)", () => {
    for (let i = 0; i < 5; i++) {
      bus.publish({ type: "apikey.revoked", keyId: `k${i}` }, admin);
    }
    const page = log.query({
      from: "2026-01-01T00:00:01.000Z",
      to: "2026-01-01T00:00:03.000Z",
    });
    expect(page.total).toBe(2);
    expect(page.entries.map((e) => e.subjectId)).toEqual(["k2", "k1"]);
  });

  it("paginates newest first", () => {
    for (let i = 0; i < 7; i++) {
      bus.publish({ type: "apikey.revoked", keyId: `k${i}` }, admin);
    }
    const first = log.query({ limit: 3 });
    const second = log.query({ limit: 3, offset: 3 });
    const third = log.query({ limit: 3, offset: 6 });

    expect(first.entries.map((e) => e.subjectId)).toEqual(["k6", "k5", "k4"]);
    expect(second.entries.map((e) => e.subjectId)).toEqual(["k3", "k2", "k1"]);
    expect(third.entries.map((e) => e.subjectId)).toEqual(["k0"]);
    expect(first.total).toBe(7);
  });

  it("clamps silly limits and offsets", () => {
    bus.publish({ type: "apikey.revoked", keyId: "k" }, admin);
    expect(log.query({ limit: 0 }).limit).toBe(50);
    expect(log.query({ limit: -5 }).limit).toBe(50);
    expect(log.query({ limit: 10_000 }).limit).toBe(500);
    expect(log.query({ offset: -3 }).offset).toBe(0);
  });

  it("stops recording after close()", () => {
    log.close();
    bus.publish({ type: "apikey.revoked", keyId: "k" }, admin);
    expect(log.query().total).toBe(0);
  });
});
