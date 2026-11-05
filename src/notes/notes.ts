import { randomUUID } from "crypto";
import { Actor } from "../auth/types";
import { assertPermission } from "../auth/apiKeys";
import { ValidationError } from "../domain/time";
import { EventBus } from "../events/bus";
import { NotFoundError } from "../services/bookingService";
import { BookingStore } from "../store/store";

/** A free-text comment left on a booking. */
export interface Note {
  id: string;
  bookingId: string;
  text: string;
  /** Whether the note is shown to the person who made the booking. */
  visibleToBooker: boolean;
  createdAt: string;
  createdBy: string;
  authorName: string;
}

export interface CreateNoteInput {
  text: string;
  visibleToBooker?: boolean;
}

export interface NoteSearchResult {
  note: Note;
  /** Character offsets of every match within the note text. */
  matches: number[];
}

/** Persistence for notes; implemented by the main store. */
export interface NoteStore {
  addNote(note: Note): Note;
  notesForBooking(bookingId: string): Note[];
  listNotes(): Note[];
  removeNote(id: string): boolean;
}

export const MAX_NOTE_LENGTH = 4000;

/**
 * Notes let staff leave context on a booking ("projector is broken", "guest
 * needs parking"). Anyone who can read bookings can read notes, anyone who
 * can write bookings can add them.
 */
export class NoteService {
  constructor(
    private readonly store: NoteStore & BookingStore,
    private readonly bus: EventBus,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  add(bookingId: string, input: CreateNoteInput, actor: Actor): Note {
    assertPermission(actor, "bookings:write");

    const booking = this.store.getBooking(bookingId);
    if (!booking) {
      throw new NotFoundError(`Booking not found: ${bookingId}`);
    }

    const text = input.text?.trim();
    if (!text) {
      throw new ValidationError("Note text is required");
    }
    if (text.length > MAX_NOTE_LENGTH) {
      throw new ValidationError(`Notes are limited to ${MAX_NOTE_LENGTH} characters`);
    }

    const note = this.store.addNote({
      id: randomUUID(),
      bookingId,
      text,
      visibleToBooker: input.visibleToBooker ?? true,
      createdAt: this.clock().toISOString(),
      createdBy: actor.keyId,
      authorName: actor.name,
    });

    this.bus.publish({ type: "note.added", noteId: note.id, bookingId, text }, actor);
    return note;
  }

  list(bookingId: string, actor: Actor): Note[] {
    assertPermission(actor, "bookings:read");
    if (!this.store.getBooking(bookingId)) {
      throw new NotFoundError(`Booking not found: ${bookingId}`);
    }
    return this.store.notesForBooking(bookingId);
  }

  remove(noteId: string, actor: Actor): void {
    assertPermission(actor, "bookings:write");
    if (!this.store.removeNote(noteId)) {
      throw new NotFoundError(`Note not found: ${noteId}`);
    }
  }

  /**
   * Full-text search across every note. The query is interpreted as a regular
   * expression so callers can do things like `parking|garage`.
   */
  search(query: string, actor: Actor): NoteSearchResult[] {
    assertPermission(actor, "bookings:read");
    if (!query) {
      return [];
    }
    const pattern = new RegExp(query, "gi");
    const results: NoteSearchResult[] = [];
    for (const note of this.store.listNotes()) {
      const matches: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(note.text)) !== null) {
        matches.push(m.index);
        if (m[0].length === 0) {
          pattern.lastIndex++;
        }
      }
      if (matches.length > 0) {
        results.push({ note, matches });
      }
      pattern.lastIndex = 0;
    }
    return results.sort((a, b) => b.matches.length - a.matches.length);
  }

  /** Notes across all bookings a given key created, for the "my notes" view. */
  byAuthor(keyId: string, actor: Actor): Note[] {
    assertPermission(actor, "bookings:read");
    return this.store.listNotes().filter((n) => n.createdBy == keyId);
  }
}
