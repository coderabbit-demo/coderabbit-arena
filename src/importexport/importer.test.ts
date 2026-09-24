import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { deepMerge, ImportExportService, parseCsv, toCsv } from "./importer";
import { ImportError } from "./types";
import { EventBus } from "../events/bus";
import { InMemoryStore } from "../store/store";
import { Actor } from "../auth/types";

const admin: Actor = { keyId: "k-admin", name: "Admin", role: "admin" };
const member: Actor = { keyId: "k-member", name: "Member", role: "member" };

let dir: string;
let store: InMemoryStore;
let bus: EventBus;
let service: ImportExportService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exports-"));
  store = new InMemoryStore();
  bus = new EventBus();
  service = new ImportExportService(store, bus, {
    exportsDir: dir,
    clock: () => new Date("2026-09-20T12:00:00.000Z"),
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("deepMerge", () => {
  it("merges nested objects and overrides scalars", () => {
    expect(deepMerge({ a: 1, b: { c: 1, d: 2 } }, { b: { c: 9 }, e: 3 })).toEqual({
      a: 1,
      b: { c: 9, d: 2 },
      e: 3,
    });
  });

  it("replaces arrays", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it("does not mutate the target", () => {
    const target = { a: { b: 1 } };
    deepMerge(target, { a: { b: 2 } });
    expect(target.a.b).toBe(1);
  });
});

describe("parseCsv / toCsv", () => {
  it("parses headers and quoted fields", () => {
    const rows = parseCsv('name,capacity\n"Room, A",2\nRoom B,"3"\n');
    expect(rows).toEqual([
      { name: "Room, A", capacity: "2" },
      { name: "Room B", capacity: "3" },
    ]);
  });

  it("handles doubled quotes", () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([{ a: 'say "hi"' }]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });

  it("serialises rows with a union header", () => {
    expect(toCsv([{ a: 1 }, { a: 2, b: "x,y" }])).toBe('a,b\n1,\n2,"x,y"');
  });
});

describe("ImportExportService.importPayload", () => {
  it("imports resources and bookings", () => {
    const result = service.importPayload(
      {
        resources: [{ id: "r1", name: "Room A", capacity: "2" }, { name: "Room B" }],
        bookings: [
          {
            resourceId: "r1",
            bookedBy: "Ada",
            start: "2026-10-01T09:00:00Z",
            end: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {},
      admin,
    );
    expect(result.resourcesCreated).toBe(2);
    expect(result.bookingsCreated).toBe(1);
    expect(result.errors).toEqual([]);
    expect(store.getResource("r1")?.capacity).toBe(2);
    expect(store.listResources()[1].capacity).toBe(1);
    expect(store.listBookings()[0].start).toBe("2026-10-01T09:00:00.000Z");
    expect(store.listBookings()[0].createdBy).toBe("k-admin");
  });

  it("applies defaults under row values", () => {
    service.importPayload(
      {
        defaults: { booking: { resourceId: "r1", bookedBy: "Ops" } },
        bookings: [
          { start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z" },
          { start: "2026-10-02T09:00:00Z", end: "2026-10-02T10:00:00Z", bookedBy: "Ada" },
        ],
      },
      {},
      admin,
    );
    expect(store.listBookings().map((b) => b.bookedBy)).toEqual(["Ops", "Ada"]);
  });

  it("collects row errors and keeps going by default", () => {
    const result = service.importPayload(
      { resources: [{ name: "" }, { name: "ok" }, { name: "bad", capacity: "zero" }] },
      {},
      admin,
    );
    expect(result.resourcesCreated).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.errors.map((e) => e.index)).toEqual([0, 2]);
  });

  it("aborts on the first error in strict mode", () => {
    expect(() =>
      service.importPayload({ resources: [{ name: "" }] }, { continueOnError: false }, admin),
    ).toThrow(ImportError);
  });

  it("writes nothing on a dry run", () => {
    const result = service.importPayload({ resources: [{ name: "x" }] }, { dryRun: true }, admin);
    expect(result.resourcesCreated).toBe(1);
    expect(store.listResources()).toEqual([]);
  });

  it("publishes import.completed", () => {
    const events: string[] = [];
    bus.subscribe("import.completed", (e) => events.push(e.event.type));
    service.importPayload({ resources: [{ name: "x" }] }, {}, admin);
    expect(events).toEqual(["import.completed"]);
  });

  it("rejects bookings whose end precedes start", () => {
    const result = service.importPayload(
      {
        bookings: [
          { resourceId: "r", bookedBy: "A", start: "2026-10-01T10:00:00Z", end: "2026-10-01T09:00:00Z" },
        ],
      },
      {},
      admin,
    );
    expect(result.errors[0].message).toMatch(/end must be after start/);
  });

  it("members cannot import", () => {
    expect(() => service.importPayload({}, {}, member)).toThrow(/not allowed/);
  });
});

describe("ImportExportService.importFromUrl", () => {
  it("fetches JSON and imports it", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ resources: [{ name: "Remote" }] }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const svc = new ImportExportService(store, bus, { exportsDir: dir, fetchImpl });
    const result = await svc.importFromUrl("https://example.com/data.json", {}, admin);
    expect(result.resourcesCreated).toBe(1);
  });

  it("treats CSV responses as booking rows", async () => {
    const csv = "resourceId,bookedBy,start,end\nr1,Ada,2026-10-01T09:00:00Z,2026-10-01T10:00:00Z";
    const fetchImpl = (async () =>
      new Response(csv, { headers: { "content-type": "text/csv" } })) as unknown as typeof fetch;
    const svc = new ImportExportService(store, bus, { exportsDir: dir, fetchImpl });
    const result = await svc.importFromUrl("https://example.com/data", {}, admin);
    expect(result.bookingsCreated).toBe(1);
  });

  it("fails on non-2xx responses", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const svc = new ImportExportService(store, bus, { exportsDir: dir, fetchImpl });
    await expect(svc.importFromUrl("https://example.com/x", {}, admin)).rejects.toThrow(/500/);
  });

  it("requires a url", async () => {
    await expect(service.importFromUrl("", {}, admin)).rejects.toThrow(/url is required/);
  });
});

describe("ImportExportService export", () => {
  beforeEach(() => {
    service.importPayload(
      {
        resources: [{ id: "r1", name: "Room A" }],
        bookings: [
          { resourceId: "r1", bookedBy: "Ada", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z" },
        ],
      },
      {},
      admin,
    );
  });

  it("exports everything as a bundle", () => {
    const bundle = service.exportAll(admin);
    expect(bundle.version).toBe(1);
    expect(bundle.exportedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(bundle.resources).toHaveLength(1);
    expect(bundle.bookings).toHaveLength(1);
  });

  it("writes and lists export files", () => {
    const written = service.exportToFile("nightly", admin);
    expect(written.path).toBe(path.join(dir, "nightly.json"));
    expect(fs.existsSync(written.path)).toBe(true);
    const listed = service.listExports(admin);
    expect(listed.map((e) => e.name)).toEqual(["nightly.json"]);
    expect(JSON.parse(service.readExport("nightly.json", admin)).resources).toHaveLength(1);
  });

  it("uses a timestamp when no name is given", () => {
    const written = service.exportToFile("", admin);
    expect(path.basename(written.path)).toBe("2026-09-20T12:00:00.000Z.json");
  });

  it("exports bookings as CSV", () => {
    const csv = service.exportBookingsCsv(member);
    const [header, row] = csv.split("\n");
    expect(header).toBe("id,resourceId,bookedBy,start,end,status,createdBy");
    expect(row).toContain(",r1,Ada,2026-10-01T09:00:00.000Z,");
  });

  it("throws for unknown export files", () => {
    expect(() => service.readExport("missing.json", admin)).toThrow(/Export not found/);
  });

  it("members cannot export bundles", () => {
    expect(() => service.exportAll(member)).toThrow(/not allowed/);
  });
});
