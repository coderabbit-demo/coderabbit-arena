import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationService } from "./notifications";
import { isEmailAddress, MemoryMailer, serialize } from "./mailer";
import { EventBus } from "../events/bus";
import { InMemoryStore } from "../store/store";
import { Actor } from "../auth/types";
import { Booking, Resource } from "../domain/types";

const admin: Actor = { keyId: "k-admin", name: "Admin", role: "admin" };
const member: Actor = { keyId: "k-member", name: "Front desk", role: "member" };

const room: Resource = { id: "r1", name: "Boardroom", capacity: 1, createdBy: "k-admin" };
const booking: Booking = {
  id: "b1",
  resourceId: "r1",
  bookedBy: "Ada",
  start: "2026-10-01T09:00:00.000Z",
  end: "2026-10-01T10:30:00.000Z",
  status: "confirmed",
  createdAt: "2026-09-20T12:00:00.000Z",
  createdBy: "k-member",
};

let store: InMemoryStore;
let bus: EventBus;
let mailer: MemoryMailer;
let service: NotificationService;

beforeEach(() => {
  store = new InMemoryStore();
  bus = new EventBus();
  mailer = new MemoryMailer();
  store.addResource(room);
  store.addBooking(booking);
  service = new NotificationService(store, bus, mailer, {
    publicBaseUrl: "https://booking.example.com",
    clock: () => new Date("2026-09-20T12:00:00.000Z"),
    retryIntervalMs: 60_000,
  });
});

afterEach(() => {
  service.close();
});

describe("mailer helpers", () => {
  it("validates addresses loosely", () => {
    expect(isEmailAddress("ada@example.com")).toBe(true);
    expect(isEmailAddress("not an email")).toBe(false);
    expect(isEmailAddress(42)).toBe(false);
  });

  it("serialises a message", () => {
    const raw = serialize(
      { to: "a@b.c", subject: "Hi", body: "Body", html: false, headers: { "X-Test": "1" } },
      "no-reply@example.com",
    );
    expect(raw).toContain("To: a@b.c\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toContain("X-Test: 1");
    expect(raw.endsWith("\r\n\r\nBody")).toBe(true);
  });
});

describe("contacts", () => {
  it("upserts and lists contacts", () => {
    service.upsertContact({ name: "Ada", email: "ada@example.com" }, member);
    service.upsertContact({ name: "Ada", email: "ada@new.example.com" }, member);
    const contacts = service.listContacts(member);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].email).toBe("ada@new.example.com");
  });

  it("rejects bad input", () => {
    expect(() => service.upsertContact({ name: "", email: "a@b.c" }, member)).toThrow(/required/);
    expect(() => service.upsertContact({ name: "Ada", email: "nope" }, member)).toThrow(/Invalid/);
  });
});

describe("templates", () => {
  it("seeds defaults", () => {
    const templates = service.listTemplates(admin);
    expect(templates.map((t) => t.event)).toContain("booking.created");
  });

  it("lets admins override a template", () => {
    const t = service.upsertTemplate(
      { event: "booking.created", subject: "Yo {{ booking.bookedBy }}", body: "ok" },
      admin,
    );
    expect(t.updatedBy).toBe("k-admin");
    expect(store.getTemplate("booking.created")?.subject).toBe("Yo {{ booking.bookedBy }}");
  });

  it("rejects unknown events and broken templates", () => {
    expect(() =>
      service.upsertTemplate({ event: "nope", subject: "a", body: "b" }, admin),
    ).toThrow(/Unknown event/);
    expect(() =>
      service.upsertTemplate({ event: "booking.created", subject: "{{ ( }}", body: "b" }, admin),
    ).toThrow(/Invalid expression/);
  });

  it("members cannot edit templates", () => {
    expect(() =>
      service.upsertTemplate({ event: "booking.created", subject: "a", body: "b" }, member),
    ).toThrow(/not allowed/);
  });

  it("previews with sample data", () => {
    const preview = service.preview(
      { event: "booking.created", subject: "{{ resource.name }}", body: "{{ booking.bookedBy }}" },
      admin,
    );
    expect(preview.subject).toBe("Boardroom");
    expect(preview.body).toBe("Ada Lovelace");
  });
});

describe("delivery", () => {
  it("emails the booker when a booking is created", async () => {
    service.upsertContact({ name: "Ada", email: "ada@example.com" }, member);
    bus.publish({ type: "booking.created", booking }, member);
    await service.drain();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("ada@example.com");
    expect(mailer.sent[0].subject).toBe("Booking confirmed: Boardroom");
    expect(mailer.sent[0].body).toContain("Booking reference: b1");
  });

  it("skips bookers without a contact", async () => {
    bus.publish({ type: "booking.created", booking }, member);
    await service.drain();
    expect(mailer.sent).toHaveLength(0);
  });

  it("respects unsubscribes", async () => {
    service.upsertContact({ name: "Ada", email: "ada@example.com", subscribed: false }, member);
    bus.publish({ type: "booking.created", booking }, member);
    await service.drain();
    expect(mailer.sent).toHaveLength(0);
  });

  it("includes note text in note notifications", async () => {
    service.upsertContact({ name: "Ada", email: "ada@example.com" }, member);
    bus.publish({ type: "note.added", noteId: "n1", bookingId: "b1", text: "Bring ID" }, member);
    await service.drain();
    expect(mailer.sent[0].html).toBe(true);
    expect(mailer.sent[0].body).toContain("Front desk left a note");
    expect(mailer.sent[0].body).toContain("Bring ID");
  });

  it("links to the attachment download", async () => {
    service.upsertContact({ name: "Ada", email: "ada@example.com" }, member);
    bus.publish(
      {
        type: "attachment.uploaded",
        attachmentId: "a1",
        bookingId: "b1",
        filename: "agenda.pdf",
        size: 10,
      },
      member,
    );
    await service.drain();
    expect(mailer.sent[0].body).toContain("https://booking.example.com/files/b1/agenda.pdf");
  });

  it("emails invitees directly", async () => {
    bus.publish(
      {
        type: "invite.created",
        inviteId: "i1",
        email: "new@example.com",
        role: "member",
        token: "tok.mac",
        expiresAt: "2026-09-23T12:00:00.000Z",
      },
      admin,
    );
    await service.drain();
    expect(mailer.sent[0].to).toBe("new@example.com");
    expect(mailer.sent[0].body).toContain("/invites/tok.mac/accept");
  });

  it("ignores events without a template", async () => {
    bus.publish({ type: "apikey.revoked", keyId: "k" }, admin);
    await service.drain();
    expect(mailer.sent).toHaveLength(0);
  });

  it("queues failed sends for retry", async () => {
    let fail = true;
    const flaky = {
      async send(message: { to: string }) {
        if (fail) {
          return { accepted: false, messageId: null, error: "down" };
        }
        mailer.sent.push(message as never);
        return { accepted: true, messageId: "ok" };
      },
    };
    const svc = new NotificationService(store, bus, flaky, {
      publicBaseUrl: "https://x",
      retryIntervalMs: 60_000,
    });
    service.close();
    svc.upsertContact({ name: "Ada", email: "ada@example.com" }, member);
    bus.publish({ type: "booking.created", booking }, member);
    await svc.drain();
    expect(mailer.sent).toHaveLength(0);
    fail = false;
    svc.flush();
    await svc.drain();
    expect(mailer.sent).toHaveLength(1);
    svc.close();
  });
});
