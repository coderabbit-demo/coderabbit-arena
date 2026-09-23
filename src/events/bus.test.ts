import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus";
import { Actor } from "../auth/types";
import { Resource } from "../domain/types";

const actor: Actor = { keyId: "k1", name: "Ada", role: "admin" };
const room: Resource = { id: "r1", name: "Room", capacity: 1, createdBy: "k1" };

describe("EventBus", () => {
  it("delivers to type-specific and wildcard subscribers", () => {
    const bus = new EventBus();
    const specific = vi.fn();
    const wildcard = vi.fn();
    const other = vi.fn();

    bus.subscribe("resource.created", specific);
    bus.subscribe("*", wildcard);
    bus.subscribe("booking.created", other);

    const envelope = bus.publish({ type: "resource.created", resource: room }, actor);

    expect(specific).toHaveBeenCalledWith(envelope);
    expect(wildcard).toHaveBeenCalledWith(envelope);
    expect(other).not.toHaveBeenCalled();
  });

  it("wraps events with id, timestamp and actor", () => {
    const bus = new EventBus(undefined, () => new Date("2026-01-01T00:00:00.000Z"));
    const envelope = bus.publish({ type: "resource.created", resource: room }, actor);

    expect(envelope.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(envelope.actor).toEqual(actor);
    expect(envelope.event.type).toBe("resource.created");
  });

  it("isolates a throwing handler from the others", () => {
    const onError = vi.fn();
    const bus = new EventBus(onError);
    const boom = new Error("boom");
    const second = vi.fn();

    bus.subscribe("*", () => {
      throw boom;
    });
    bus.subscribe("*", second);

    const envelope = bus.publish({ type: "apikey.revoked", keyId: "k2" }, actor);

    expect(second).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom, envelope);
  });

  it("unsubscribes", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.subscribe("*", handler);
    expect(bus.subscriberCount("*")).toBe(1);

    off();
    bus.publish({ type: "apikey.revoked", keyId: "k2" }, null);

    expect(handler).not.toHaveBeenCalled();
    expect(bus.subscriberCount("*")).toBe(0);
  });

  it("keeps a bounded history", () => {
    const bus = new EventBus(undefined, undefined, 2);
    bus.publish({ type: "apikey.revoked", keyId: "a" }, null);
    bus.publish({ type: "apikey.revoked", keyId: "b" }, null);
    bus.publish({ type: "apikey.revoked", keyId: "c" }, null);

    const ids = bus.recent().map((e) => (e.event.type === "apikey.revoked" ? e.event.keyId : ""));
    expect(ids).toEqual(["b", "c"]);
  });
});
