import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AttachmentService, checksum, contentTypeFor, DEFAULT_CONTENT_TYPE } from "./attachments";
import { AttachmentError } from "./types";
import { EventBus } from "../events/bus";
import { InMemoryStore } from "../store/store";
import { Actor } from "../auth/types";
import { Booking } from "../domain/types";

const admin: Actor = { keyId: "k-admin", name: "Admin", role: "admin" };
const member: Actor = { keyId: "k-member", name: "Member", role: "member" };
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

let root: string;
let store: InMemoryStore;
let bus: EventBus;
let service: AttachmentService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-"));
  store = new InMemoryStore();
  bus = new EventBus();
  store.addBooking(booking);
  service = new AttachmentService(root, store, bus, {
    maxBytes: 1024,
    clock: () => new Date("2026-08-01T00:00:00.000Z"),
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("contentTypeFor", () => {
  it("maps known extensions", () => {
    expect(contentTypeFor("agenda.pdf")).toBe("application/pdf");
    expect(contentTypeFor("PHOTO.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("notes.md")).toBe("text/markdown");
  });

  it("falls back to octet-stream", () => {
    expect(contentTypeFor("archive.zip")).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeFor("noext")).toBe(DEFAULT_CONTENT_TYPE);
  });
});

describe("checksum", () => {
  it("is stable for equal content", () => {
    expect(checksum(Buffer.from("hello"))).toBe(checksum(Buffer.from("hello")));
    expect(checksum(Buffer.from("hello"))).not.toBe(checksum(Buffer.from("hellO")));
  });
});

describe("AttachmentService.upload", () => {
  it("writes the file under the booking directory and records metadata", () => {
    const a = service.upload(
      { bookingId: "b1", filename: "agenda.pdf", bytes: Buffer.from("%PDF-1.4") },
      member,
    );
    expect(a.bookingId).toBe("b1");
    expect(a.filename).toBe("agenda.pdf");
    expect(a.contentType).toBe("application/pdf");
    expect(a.size).toBe(8);
    expect(a.uploadedBy).toBe("k-member");
    expect(fs.existsSync(path.join(root, "b1", "agenda.pdf"))).toBe(true);
    expect(store.getAttachment(a.id)).toEqual(a);
  });

  it("prefers an explicit content type", () => {
    const a = service.upload(
      {
        bookingId: "b1",
        filename: "data.bin",
        contentType: "application/x-custom",
        bytes: Buffer.from("x"),
      },
      member,
    );
    expect(a.contentType).toBe("application/x-custom");
  });

  it("publishes an attachment.uploaded event", () => {
    const seen: string[] = [];
    bus.subscribe("attachment.uploaded", (e) => seen.push(e.event.type));
    service.upload({ bookingId: "b1", filename: "a.txt", bytes: Buffer.from("a") }, member);
    expect(seen).toEqual(["attachment.uploaded"]);
  });

  it("rejects unknown bookings", () => {
    expect(() =>
      service.upload({ bookingId: "nope", filename: "a.txt", bytes: Buffer.from("a") }, member),
    ).toThrow(/Booking not found/);
  });

  it("rejects empty bodies and missing filenames", () => {
    expect(() =>
      service.upload({ bookingId: "b1", filename: "", bytes: Buffer.from("a") }, member),
    ).toThrow(AttachmentError);
    expect(() =>
      service.upload({ bookingId: "b1", filename: "a.txt", bytes: Buffer.alloc(0) }, member),
    ).toThrow(/empty/);
  });

  it("rejects files over the size limit", () => {
    expect(() =>
      service.upload({ bookingId: "b1", filename: "big.bin", bytes: Buffer.alloc(2048) }, member),
    ).toThrow(/exceeds/);
  });

  it("viewers cannot upload", () => {
    expect(() =>
      service.upload({ bookingId: "b1", filename: "a.txt", bytes: Buffer.from("a") }, viewer),
    ).toThrow(/not allowed/);
  });
});

describe("AttachmentService.list / read / remove", () => {
  it("lists attachments for a booking", () => {
    service.upload({ bookingId: "b1", filename: "one.txt", bytes: Buffer.from("1") }, member);
    service.upload({ bookingId: "b1", filename: "two.txt", bytes: Buffer.from("2") }, member);
    const listed = service.list("b1", viewer);
    expect(listed.map((a) => a.filename)).toEqual(["one.txt", "two.txt"]);
  });

  it("returns an empty list for a booking with no files", () => {
    expect(service.list("b1", viewer)).toEqual([]);
  });

  it("reads bytes back", () => {
    const a = service.upload(
      { bookingId: "b1", filename: "hello.txt", bytes: Buffer.from("hello") },
      member,
    );
    const { attachment, bytes } = service.read(a.id, viewer);
    expect(attachment.id).toBe(a.id);
    expect(bytes.toString()).toBe("hello");
  });

  it("404s for unknown attachment ids", () => {
    try {
      service.read("missing", viewer);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentError);
      expect((err as AttachmentError).status).toBe(404);
    }
  });

  it("removes the file and the metadata", () => {
    const a = service.upload({ bookingId: "b1", filename: "x.txt", bytes: Buffer.from("x") }, member);
    service.remove(a.id, admin);
    expect(store.getAttachment(a.id)).toBeUndefined();
    expect(fs.existsSync(path.join(root, "b1", "x.txt"))).toBe(false);
  });

  it("serves files by relative path", () => {
    service.upload({ bookingId: "b1", filename: "link.txt", bytes: Buffer.from("link") }, member);
    const file = service.readRelative("b1/link.txt");
    expect(file.contentType).toBe("text/plain");
    expect(file.bytes.toString()).toBe("link");
  });

  it("refuses relative paths outside the root", () => {
    expect(() => service.readRelative("../../etc/passwd")).toThrow(AttachmentError);
  });
});

describe("AttachmentService.usage / sweepOrphans", () => {
  it("sums file sizes on disk", () => {
    service.upload({ bookingId: "b1", filename: "a.txt", bytes: Buffer.alloc(10) }, member);
    service.upload({ bookingId: "b1", filename: "b.txt", bytes: Buffer.alloc(15) }, member);
    expect(service.usage("b1")).toBe(25);
    expect(service.usage("nope")).toBe(0);
  });

  it("deletes files without metadata", () => {
    service.upload({ bookingId: "b1", filename: "keep.txt", bytes: Buffer.from("k") }, member);
    fs.writeFileSync(path.join(root, "b1", "stray.tmp"), "stray");
    expect(service.sweepOrphans()).toBe(1);
    expect(fs.existsSync(path.join(root, "b1", "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "b1", "stray.tmp"))).toBe(false);
  });
});
