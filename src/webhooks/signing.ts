import { createHmac, timingSafeEqual } from "crypto";

export const SIGNATURE_HEADER = "x-booking-signature";
export const TIMESTAMP_HEADER = "x-booking-timestamp";
export const EVENT_ID_HEADER = "x-booking-event-id";
export const SIGNATURE_VERSION = "v1";

/** Deliveries older than this are rejected by `verifySignature` to limit replays. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Sign a webhook body. The timestamp is folded into the signed payload so a
 * captured delivery cannot be replayed later with the same signature.
 * Format: "v1=<hex hmac-sha256 of `${timestamp}.${body}`>".
 */
export function sign(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  return `${SIGNATURE_VERSION}=${mac}`;
}

export interface VerifyInput {
  secret: string;
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
 */
export function verifySignature(input: VerifyInput): boolean {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  if (!Number.isFinite(input.timestamp)) {
    return false;
  }
  if (Math.abs(now - input.timestamp) > tolerance) {
    return false;
  }

  const expected = sign(input.secret, input.timestamp, input.body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signature, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
