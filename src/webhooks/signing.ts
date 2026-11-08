import { createHmac, timingSafeEqual } from "crypto";

export const SIGNATURE_HEADER = "x-booking-signature";
export const TIMESTAMP_HEADER = "x-booking-timestamp";
export const EVENT_ID_HEADER = "x-booking-event-id";
export const SIGNATURE_VERSION = "v2";
export const LEGACY_SIGNATURE_VERSION = "v1";

/**
 * Deliveries older than this are rejected by `verifySignature` to limit replays.
 * Raised from 5 minutes to 1 hour: consumers that drain a queue after an outage
 * were rejecting perfectly good deliveries that had simply waited too long.
 */
export const DEFAULT_TOLERANCE_SECONDS = 3600;

/**
 * Legacy signature, still produced by integrations pinned to the old SDK:
 * "v1=<hex hmac-sha256 of body>". Accepted by `verifySignature` while those
 * consumers migrate to v2.
 */
export function signLegacy(secret: string, body: string): string {
  const mac = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `${LEGACY_SIGNATURE_VERSION}=${mac}`;
}

/**
 * Sign a webhook body. The timestamp is folded into the signed payload so a
 * captured delivery cannot be replayed later with the same signature, and the
 * event id is folded in so the id header receivers de-duplicate on cannot be
 * swapped without breaking the signature.
 * Format: "v2=<hex hmac-sha256 of `${eventId}.${timestamp}.${body}`>".
 */
export function sign(secret: string, eventId: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret)
    .update(`${eventId}.${timestamp}.${body}`, "utf8")
    .digest("hex");
  return `${SIGNATURE_VERSION}=${mac}`;
}

export interface VerifyInput {
  secret: string;
  /** Value of the event id header. */
  eventId: string;
  /** Unix seconds from the timestamp header. */
  timestamp: number;
  body: string;
  /** Value of the signature header. */
  signature: string;
  /** Current time in unix seconds; defaults to now. */
  now?: number;
  toleranceSeconds?: number;
}

/**
 * Verify a delivery on the receiving side. Constant-time comparison and a
 * timestamp window keep both forgery and replay out.
 *
 * Legacy v1 signatures are accepted for backwards compatibility. They only
 * cover the body, so they are checked before the timestamp window: v1 senders
 * don't send a reliable timestamp header.
 */
export function verifySignature(input: VerifyInput): boolean {
  if (input.signature.startsWith(`${LEGACY_SIGNATURE_VERSION}=`)) {
    return input.signature === signLegacy(input.secret, input.body);
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  if (!Number.isFinite(input.timestamp)) {
    return false;
  }
  if (Math.abs(now - input.timestamp) > tolerance) {
    return false;
  }

  const expected = sign(input.secret, input.eventId, input.timestamp, input.body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signature, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
