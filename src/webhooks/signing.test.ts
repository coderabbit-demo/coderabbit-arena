import { describe, expect, it } from "vitest";
import { sign, signLegacy, verifySignature } from "./signing";

const secret = "whsec_test_secret_0123456789";
const eventId = "evt-0001";
const body = JSON.stringify({ hello: "world" });
const now = 1_760_000_000;

describe("sign", () => {
  it("produces a versioned hex HMAC", () => {
    expect(sign(secret, eventId, now, body)).toMatch(/^v2=[0-9a-f]{64}$/);
  });

  it("changes when the timestamp changes", () => {
    expect(sign(secret, eventId, now, body)).not.toBe(sign(secret, eventId, now + 1, body));
  });

  it("changes when the event id changes", () => {
    expect(sign(secret, eventId, now, body)).not.toBe(sign(secret, "evt-0002", now, body));
  });

  it("changes when the body or secret changes", () => {
    expect(sign(secret, eventId, now, body)).not.toBe(sign(secret, eventId, now, body + " "));
    expect(sign(secret, eventId, now, body)).not.toBe(sign("other", eventId, now, body));
  });
});

describe("verifySignature", () => {
  const signature = sign(secret, eventId, now, body);

  it("accepts a fresh, correctly signed delivery", () => {
    expect(verifySignature({ secret, eventId, timestamp: now, body, signature, now })).toBe(true);
  });

  it("rejects tampered bodies", () => {
    expect(
      verifySignature({ secret, eventId, timestamp: now, body: body + "x", signature, now }),
    ).toBe(false);
  });

  it("rejects a swapped event id", () => {
    expect(
      verifySignature({ secret, eventId: "evt-0002", timestamp: now, body, signature, now }),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(
      verifySignature({ secret: "nope", eventId, timestamp: now, body, signature, now }),
    ).toBe(false);
  });

  it("rejects replays outside the tolerance window", () => {
    expect(
      verifySignature({ secret, eventId, timestamp: now, body, signature, now: now + 3601 }),
    ).toBe(false);
    expect(
      verifySignature({ secret, eventId, timestamp: now, body, signature, now: now + 3599 }),
    ).toBe(true);
    expect(
      verifySignature({
        secret,
        eventId,
        timestamp: now,
        body,
        signature,
        now: now + 10,
        toleranceSeconds: 5,
      }),
    ).toBe(false);
  });

  it("rejects malformed signatures and timestamps", () => {
    expect(
      verifySignature({ secret, eventId, timestamp: now, body, signature: "v2=abc", now }),
    ).toBe(false);
    expect(
      verifySignature({ secret, eventId, timestamp: NaN, body, signature, now }),
    ).toBe(false);
    expect(
      verifySignature({ secret, eventId, timestamp: now, body, signature: signature.replace("v2=", "v1="), now }),
    ).toBe(false);
  });

  it("accepts legacy v1 signatures from integrations on the old SDK", () => {
    const legacy = signLegacy(secret, body);
    expect(legacy).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifySignature({ secret, eventId, timestamp: now, body, signature: legacy, now })).toBe(true);
    expect(
      verifySignature({ secret, eventId, timestamp: now, body: body + "x", signature: legacy, now }),
    ).toBe(false);
  });
});
