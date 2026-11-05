import { describe, expect, it } from "vitest";
import { ShareLinkService } from "./shareLinks";
import { NotFoundError } from "./bookingService";
import { InMemoryStore } from "../store/store";
import { Booking } from "../domain/types";

function booking(store: InMemoryStore, id = "b1"): Booking {
  return store.addBooking({
    id,
    resourceId: "r1",
    bookedBy: "Ada",
    start: "2026-08-01T09:00:00.000Z",
    end: "2026-08-01T10:00:00.000Z",
    status: "confirmed",
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "k1",
  });
}

describe("ShareLinkService", () => {
  it("mints a link and resolves it back to the booking", () => {
    const store = new InMemoryStore();
    const b = booking(store);
    const svc = new ShareLinkService(store);
    const link = svc.create(b.id);
    expect(link.token).toHaveLength(12);
    expect(svc.resolve(link.token).id).toBe(b.id);
  });

  it("reuses the same token for the same booking", () => {
    const store = new InMemoryStore();
    const b = booking(store);
    const svc = new ShareLinkService(store);
    expect(svc.create(b.id).token).toBe(svc.create(b.id).token);
  });

  it("throws for an unknown token", () => {
    const svc = new ShareLinkService(new InMemoryStore());
    expect(() => svc.resolve("nope")).toThrow(NotFoundError);
  });

  it("throws when the booking does not exist", () => {
    const svc = new ShareLinkService(new InMemoryStore());
    expect(() => svc.create("missing")).toThrow(NotFoundError);
  });
});
