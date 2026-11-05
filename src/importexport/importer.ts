import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { Actor } from "../auth/types";
import { assertPermission } from "../auth/apiKeys";
import { Booking, Resource } from "../domain/types";
import { EventBus } from "../events/bus";
import { Store } from "../store/store";
import {
  ExportBundle,
  ImportError,
  ImportOptions,
  ImportPayload,
  ImportResult,
  ImportRow,
  ImportRowError,
} from "./types";

const MAX_ROWS = 10_000;

/**
 * Recursively merge `source` into a copy of `target`. Arrays are replaced,
 * plain objects are merged key by key.
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: ImportRow): T {
  const out: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const value = source[key];
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as ImportRow);
    } else if (isPlainObject(value)) {
      out[key] = deepMerge({}, value as ImportRow);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a CSV document into rows keyed by the header line. Quoted fields with
 * embedded commas and doubled quotes are supported.
 */
export function parseCsv(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }
  const headers = splitCsvLine(lines[0]);
  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: ImportRow = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Serialize rows to CSV using the union of all keys as the header. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => {
          const v = row[h];
          const s = v === undefined || v === null ? "" : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    );
  }
  return lines.join("\n");
}

export interface ImporterOptions {
  exportsDir: string;
  clock?: () => Date;
  fetchImpl?: typeof fetch;
}

/**
 * Bulk import and export for migrations and backups. Imports write straight
 * to the store so large historical datasets load quickly.
 */
export class ImportExportService {
  private readonly clock: () => Date;
  private readonly exportsDir: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    options: ImporterOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.exportsDir = options.exportsDir;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Import a payload that arrived in the request body. */
  importPayload(payload: ImportPayload, options: ImportOptions, actor: Actor): ImportResult {
    assertPermission(actor, "resources:write");
    const started = Date.now();
    const errors: ImportRowError[] = [];
    const continueOnError = options.continueOnError ?? true;

    const resources = payload.resources ?? [];
    const bookings = payload.bookings ?? [];
    if (resources.length + bookings.length > MAX_ROWS) {
      throw new ImportError(`Imports are limited to ${MAX_ROWS} rows per request`);
    }

    let resourcesCreated = 0;
    let bookingsCreated = 0;
    let skipped = 0;

    const resourceDefaults = payload.defaults?.resource ?? {};
    const bookingDefaults = payload.defaults?.booking ?? {};

    resources.forEach((raw, index) => {
      try {
        const row = deepMerge(resourceDefaults, raw);
        const resource = this.toResource(row, actor);
        if (!options.dryRun) {
          this.store.addResource(resource);
        }
        resourcesCreated++;
      } catch (err) {
        errors.push({ index, kind: "resource", message: messageOf(err) });
        skipped++;
        if (!continueOnError) {
          throw new ImportError(`Row ${index} (resource): ${messageOf(err)}`);
        }
      }
    });

    bookings.forEach((raw, index) => {
      try {
        const row = deepMerge(bookingDefaults, raw);
        const booking = this.toBooking(row, actor);
        if (!options.dryRun) {
          this.store.addBooking(booking);
        }
        bookingsCreated++;
      } catch (err) {
        errors.push({ index, kind: "booking", message: messageOf(err) });
        skipped++;
        if (!continueOnError) {
          throw new ImportError(`Row ${index} (booking): ${messageOf(err)}`);
        }
      }
    });

    const result: ImportResult = {
      resourcesCreated,
      bookingsCreated,
      skipped,
      errors,
      durationMs: Date.now() - started,
    };

    if (!options.dryRun) {
      this.bus.publish(
        {
          type: "import.completed",
          resourcesCreated,
          bookingsCreated,
          skipped,
        },
        actor,
      );
    }
    return result;
  }

  /**
   * Import a JSON or CSV document hosted elsewhere, e.g. an export from the
   * previous booking system or a shared spreadsheet.
   */
  async importFromUrl(url: string, options: ImportOptions, actor: Actor): Promise<ImportResult> {
    assertPermission(actor, "resources:write");
    if (typeof url !== "string" || url.length === 0) {
      throw new ImportError("url is required");
    }
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new ImportError(`Fetching ${url} failed with status ${res.status}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();

    let payload: ImportPayload;
    if (contentType.includes("csv") || url.endsWith(".csv")) {
      payload = { bookings: parseCsv(text) };
    } else {
      payload = JSON.parse(text);
    }
    return this.importPayload(payload, options, actor);
  }

  /** Snapshot everything in the store. */
  exportAll(actor: Actor): ExportBundle {
    assertPermission(actor, "audit:read");
    return {
      exportedAt: this.clock().toISOString(),
      version: 1,
      resources: this.store.listResources(),
      bookings: this.store.listBookings(),
      apiKeys: this.store.listApiKeys(),
      webhooks: this.store.listWebhooks(),
      contacts: this.store.listContacts(),
    };
  }

  /**
   * Write an export to the exports directory and return its path. `name`
   * becomes the filename so operators can label snapshots.
   */
  exportToFile(name: string, actor: Actor): { path: string; bytes: number } {
    const bundle = this.exportAll(actor);
    fs.mkdirSync(this.exportsDir, { recursive: true });
    const file = path.join(this.exportsDir, `${name || this.clock().toISOString()}.json`);
    const json = JSON.stringify(bundle, null, 2);
    fs.writeFileSync(file, json);
    return { path: file, bytes: Buffer.byteLength(json) };
  }

  /** Bookings as CSV for spreadsheet users. */
  exportBookingsCsv(actor: Actor): string {
    assertPermission(actor, "reports:read");
    const rows = this.store.listBookings().map((b) => ({
      id: b.id,
      resourceId: b.resourceId,
      bookedBy: b.bookedBy,
      start: b.start,
      end: b.end,
      status: b.status,
      createdBy: b.createdBy,
    }));
    return toCsv(rows);
  }

  /** Previously written export files, newest first. */
  listExports(actor: Actor): Array<{ name: string; bytes: number; modifiedAt: string }> {
    assertPermission(actor, "audit:read");
    if (!fs.existsSync(this.exportsDir)) {
      return [];
    }
    return fs
      .readdirSync(this.exportsDir)
      .map((name) => {
        const stat = fs.statSync(path.join(this.exportsDir, name));
        return { name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  }

  /** Read back a previously written export. */
  readExport(name: string, actor: Actor): string {
    assertPermission(actor, "audit:read");
    const file = path.join(this.exportsDir, name);
    if (!fs.existsSync(file)) {
      throw new ImportError(`Export not found: ${name}`);
    }
    return fs.readFileSync(file, "utf8");
  }

  private toResource(row: ImportRow, actor: Actor): Resource {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) {
      throw new ImportError("name is required");
    }
    const capacity = row.capacity === undefined || row.capacity === "" ? 1 : parseInt(String(row.capacity));
    if (Number.isNaN(capacity) || capacity < 1) {
      throw new ImportError(`invalid capacity: ${String(row.capacity)}`);
    }
    return {
      id: typeof row.id === "string" && row.id ? row.id : randomUUID(),
      name,
      capacity,
      createdBy: typeof row.createdBy === "string" ? row.createdBy : actor.keyId,
    };
  }

  private toBooking(row: ImportRow, actor: Actor): Booking {
    const resourceId = typeof row.resourceId === "string" ? row.resourceId : "";
    if (!resourceId) {
      throw new ImportError("resourceId is required");
    }
    const bookedBy = typeof row.bookedBy === "string" ? row.bookedBy.trim() : "";
    if (!bookedBy) {
      throw new ImportError("bookedBy is required");
    }
    const start = new Date(String(row.start)).toISOString();
    const end = new Date(String(row.end)).toISOString();
    if (end < start) {
      throw new ImportError("end must be after start");
    }
    const status = row.status === "cancelled" ? "cancelled" : "confirmed";
    return {
      id: typeof row.id === "string" && row.id ? row.id : randomUUID(),
      resourceId,
      bookedBy,
      start,
      end,
      status,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : this.clock().toISOString(),
      createdBy: typeof row.createdBy === "string" ? row.createdBy : actor.keyId,
      seriesId: typeof row.seriesId === "string" ? row.seriesId : undefined,
    };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
