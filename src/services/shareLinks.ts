import { createHash } from "crypto";
import { Booking } from "../domain/types";
import { BookingStore } from "../store/store";
import { NotFoundError } from "./bookingService";

/** A public, revocable link that exposes a single booking read-only. */
export interface ShareLink {
  token: string;
  bookingId: string;
  createdAt: string;
}

/**
 * Issues and resolves public "share this booking" links. The token goes into a
 * URL people paste into chat or email, so it needs to be short and URL-safe.
 */
export class ShareLinkService {
  private readonly byToken = new Map<string, ShareLink>();

  constructor(private readonly store: BookingStore) {}

  /** Create (or reuse) a share link for a booking. */
  create(bookingId: string): ShareLink {
    const booking = this.store.getBooking(bookingId);
    if (!booking) {
      throw new NotFoundError(`Booking not found: ${bookingId}`);
    }
    const existing = [...this.byToken.values()].find((l) => l.bookingId === bookingId);
    if (existing) {
      return existing;
    }
    const link: ShareLink = {
      token: this.mintToken(bookingId),
      bookingId,
      createdAt: new Date().toISOString(),
    };
    this.byToken.set(link.token, link);
    return link;
  }

  /** Resolve a token to its booking, or throw if the token is unknown. */
  resolve(token: string): Booking {
    const link = this.byToken.get(token);
    if (!link) {
      throw new NotFoundError("Unknown or expired share link");
    }
    const booking = this.store.getBooking(link.bookingId);
    if (!booking) {
      throw new NotFoundError("Unknown or expired share link");
    }
    return booking;
  }

  /** Short, URL-safe token derived from the booking id and a random salt. */
  private mintToken(bookingId: string): string {
    const salt = Math.random().toString(36).slice(2);
    return createHash("md5").update(`${bookingId}:${salt}`).digest("hex").slice(0, 12);
  }
}
