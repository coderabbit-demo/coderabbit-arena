import { beforeEach, describe, expect, it } from "vitest";
import { MAX_NOTE_LENGTH, NoteService } from "./notes";
import { EventBus } from "../events/bus";
import { InMemoryStore } from "../store/store";
import { Actor } from "../auth/types";
import { Booking } from "../domain/types";

const member: Actor = { keyId: "k-member", name: "Member", role: "member" };
const other: Actor = { keyId: "k-other", name: "Other", role: "member" };
const viewer: Actor = { keyId: "k-viewer", name: "Viewer", role: "viewer" };

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

let store: InMemoryStore;
let bus: EventBus;
let notes: NoteService;

beforeEach(() => {
  store = new InMemoryStore();
  bus = new EventBus();
  store.addBooking(booking);
  store.addBooking({ ...booking, id: "b2" });
  notes = new NoteService(store, bus, () => new Date("2026-08-01T00:00:00.000Z"));
});

describe("NoteService.add", () => {
  it("stores a trimmed note attributed to the actor", () => {
    const n = notes.add("b1", { text: "  Needs parking  " }, member);
    expect(n.text).toBe("Needs parking");
    expect(n.createdBy).toBe("k-member");
    expect(n.authorName).toBe("Member");
    expect(n.visibleToBooker).toBe(true);
    expect(n.createdAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("supports internal-only notes", () => {
    const n = notes.add("b1", { text: "VIP", visibleToBooker: false }, member);
    expect(n.visibleToBooker).toBe(false);
  });

  it("publishes note.added", () => {
    const types: string[] = [];
    bus.subscribe("*", (e) => types.push(e.event.type));
    notes.add("b1", { text: "hi" }, member);
    expect(types).toEqual(["note.added"]);
  });

  it("rejects empty text", () => {
    expect(() => notes.add("b1", { text: "   " }, member)).toThrow(/required/);
  });

  it("rejects overly long text", () => {
    expect(() => notes.add("b1", { text: "x".repeat(MAX_NOTE_LENGTH + 1) }, member)).toThrow(
      /limited/,
    );
  });

  it("rejects unknown bookings", () => {
    expect(() => notes.add("nope", { text: "hi" }, member)).toThrow(/Booking not found/);
  });

  it("viewers cannot add notes", () => {
    expect(() => notes.add("b1", { text: "hi" }, viewer)).toThrow(/not allowed/);
  });
});

describe("NoteService.list / remove", () => {
  it("lists notes for one booking only", () => {
    notes.add("b1", { text: "one" }, member);
    notes.add("b2", { text: "two" }, member);
    notes.add("b1", { text: "three" }, other);
    expect(notes.list("b1", viewer).map((n) => n.text)).toEqual(["one", "three"]);
  });

  it("removes a note", () => {
    const n = notes.add("b1", { text: "bye" }, member);
    notes.remove(n.id, member);
    expect(notes.list("b1", viewer)).toEqual([]);
  });

  it("throws when removing an unknown note", () => {
    expect(() => notes.remove("nope", member)).toThrow(/Note not found/);
  });
});

describe("NoteService.search", () => {
  beforeEach(() => {
    notes.add("b1", { text: "Guest needs parking near the garage" }, member);
    notes.add("b2", { text: "Projector broken, parking fine" }, member);
    notes.add("b2", { text: "Nothing to see here" }, other);
  });

  it("finds notes matching a pattern, most matches first", () => {
    const results = notes.search("parking|garage", viewer);
    expect(results.map((r) => r.note.bookingId)).toEqual(["b1", "b2"]);
    expect(results[0].matches).toHaveLength(2);
  });

  it("is case-insensitive", () => {
    expect(notes.search("PROJECTOR", viewer)).toHaveLength(1);
  });

  it("returns nothing for an empty query", () => {
    expect(notes.search("", viewer)).toEqual([]);
  });
});

describe("NoteService.byAuthor", () => {
  it("filters by author key", () => {
    notes.add("b1", { text: "a" }, member);
    notes.add("b2", { text: "b" }, other);
    expect(notes.byAuthor("k-other", viewer).map((n) => n.text)).toEqual(["b"]);
  });
});
