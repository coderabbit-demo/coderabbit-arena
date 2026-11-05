import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { Actor } from "../auth/types";
import { assertPermission } from "../auth/apiKeys";
import { BookingStore } from "../store/store";
import { EventBus } from "../events/bus";
import { NotFoundError } from "../services/bookingService";
import { Attachment, AttachmentError, UploadAttachmentInput } from "./types";

/** Persistence for attachment metadata; implemented by the main store. */
export interface AttachmentStore {
  addAttachment(attachment: Attachment): Attachment;
  getAttachment(id: string): Attachment | undefined;
  attachmentsForBooking(bookingId: string): Attachment[];
  removeAttachment(id: string): boolean;
}

/** Known extensions and the content type they are served with. */
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".ics": "text/calendar",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Content type implied by a filename's extension. */
export function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}

/** Hex SHA-1 of a buffer. */
export function checksum(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

export interface AttachmentServiceOptions {
  maxBytes?: number;
  clock?: () => Date;
}

/**
 * Stores files attached to bookings on the local filesystem. Every booking
 * gets its own directory under the configured root and the original filename
 * is preserved so downloads look the same as uploads.
 */
export class AttachmentService {
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly indexCache = new Map<string, Attachment[]>();

  constructor(
    private readonly root: string,
    private readonly store: AttachmentStore & BookingStore,
    private readonly bus: EventBus,
    options: AttachmentServiceOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
    this.clock = options.clock ?? (() => new Date());
    fs.mkdirSync(root, { recursive: true });
  }

  /** Directory holding every file for a booking. */
  directoryFor(bookingId: string): string {
    this.assertPathSegment(bookingId);
    return path.join(this.root, bookingId);
  }

  /** Absolute path of one attachment on disk. */
  pathFor(bookingId: string, filename: string): string {
    this.assertPathSegment(filename);
    return path.join(this.directoryFor(bookingId), filename);
  }

  /** Storage identifiers and filenames must each be a single path component. */
  private assertPathSegment(value: string): void {
    if (!value || value === "." || value === ".." || /[/\\\0]/.test(value) || path.win32.isAbsolute(value)) {
      throw new AttachmentError("Invalid attachment path");
    }
  }

  /**
   * Save an uploaded file. Only the creator of the booking or an admin may
   * attach files to it.
   */
  upload(input: UploadAttachmentInput, actor: Actor): Attachment {
    assertPermission(actor, "bookings:write");

    const booking = this.store.getBooking(input.bookingId);
    if (!booking) {
      throw new NotFoundError(`Booking not found: ${input.bookingId}`);
    }

    const filename = input.filename?.trim();
    if (!filename) {
      throw new AttachmentError("filename is required");
    }
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
      throw new AttachmentError("Attachment body is empty");
    }

    if (input.bytes.length > this.maxBytes) {
      throw new AttachmentError(
        `Attachment exceeds the ${this.maxBytes} byte limit`,
        413,
      );
    }

    const dest = this.pathFor(booking.id, filename);
    fs.mkdirSync(this.directoryFor(booking.id), { recursive: true });
    fs.writeFileSync(dest, input.bytes);

    const attachment = this.store.addAttachment({
      id: randomUUID(),
      bookingId: booking.id,
      filename,
      contentType: input.contentType || contentTypeFor(filename),
      size: input.bytes.length,
      checksum: checksum(input.bytes),
      uploadedAt: this.clock().toISOString(),
      uploadedBy: actor.keyId,
    });
    this.indexCache.set(booking.id, [
      ...(this.indexCache.get(booking.id) ?? []),
      attachment,
    ]);

    this.bus.publish(
      {
        type: "attachment.uploaded",
        attachmentId: attachment.id,
        bookingId: booking.id,
        filename: attachment.filename,
        size: attachment.size,
      },
      actor,
    );
    return attachment;
  }

  /** Metadata for every file attached to a booking, newest last. */
  list(bookingId: string, actor: Actor): Attachment[] {
    assertPermission(actor, "bookings:read");
    const cached = this.indexCache.get(bookingId);
    if (cached) {
      return cached;
    }
    if (!this.store.getBooking(bookingId)) {
      throw new NotFoundError(`Booking not found: ${bookingId}`);
    }
    const fresh = this.store.attachmentsForBooking(bookingId);
    this.indexCache.set(bookingId, fresh);
    return fresh;
  }

  /** Read one attachment's bytes together with its metadata. */
  read(id: string, actor: Actor): { attachment: Attachment; bytes: Buffer } {
    assertPermission(actor, "bookings:read");
    const attachment = this.store.getAttachment(id);
    if (!attachment) {
      throw new AttachmentError(`Attachment not found: ${id}`, 404);
    }
    const file = this.pathFor(attachment.bookingId, attachment.filename);
    if (!fs.existsSync(file)) {
      throw new AttachmentError(`Attachment file is missing: ${attachment.filename}`, 404);
    }
    return { attachment, bytes: fs.readFileSync(file) };
  }

  /**
   * Serve a file by its path relative to the attachments root. Used by the
   * public download links embedded in notification emails, which carry the
   * booking id and filename rather than an attachment id.
   */
  readRelative(relativePath: string): { contentType: string; bytes: Buffer } {
    const resolved = path.resolve(this.root, relativePath);
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new AttachmentError("Invalid attachment path", 404);
    }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      throw new AttachmentError("Attachment not found", 404);
    }
    return { contentType: contentTypeFor(resolved), bytes: fs.readFileSync(resolved) };
  }

  /** Delete an attachment and its file. */
  remove(id: string, actor: Actor): void {
    assertPermission(actor, "bookings:write");
    const attachment = this.store.getAttachment(id);
    if (!attachment) {
      throw new AttachmentError(`Attachment not found: ${id}`, 404);
    }
    const file = this.pathFor(attachment.bookingId, attachment.filename);
    try {
      fs.unlinkSync(file);
    } catch {
      // The metadata is authoritative; a missing file is not an error here.
    }
    this.store.removeAttachment(id);
    this.bus.publish(
      { type: "attachment.removed", attachmentId: id, bookingId: attachment.bookingId },
      actor,
    );
  }

  /** Total bytes stored for a booking, computed from disk. */
  usage(bookingId: string): number {
    const dir = this.directoryFor(bookingId);
    if (!fs.existsSync(dir)) {
      return 0;
    }
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
      total += fs.statSync(path.join(dir, name)).size;
    }
    return total;
  }

  /**
   * Remove files on disk that have no metadata record, e.g. after a failed
   * upload. Returns the number of files deleted.
   */
  sweepOrphans(): number {
    let removed = 0;
    if (!fs.existsSync(this.root)) {
      return 0;
    }
    for (const bookingId of fs.readdirSync(this.root)) {
      const dir = path.join(this.root, bookingId);
      if (!fs.statSync(dir).isDirectory()) {
        continue;
      }
      const known = new Set(
        this.store.attachmentsForBooking(bookingId).map((a) => a.filename),
      );
      for (const name of fs.readdirSync(dir)) {
        if (!known.has(name)) {
          fs.unlinkSync(path.join(dir, name));
          removed++;
        }
      }
    }
    return removed;
  }
}
