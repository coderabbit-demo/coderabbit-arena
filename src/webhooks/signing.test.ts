import { describe, expect, it } from "vitest";
import { sign, verifySignature } from "./signing";

const secret = "whsec_test_secret_0123456789";
const body = JSON.stringify({ hello: "world" });
const now = 1_760_000_000;

describe("sign", () => {
  it("produces a versioned hex HMAC", () => {
    expect(sign(secret, now, body)).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("changes when the timestamp changes", () => {
    expect(sign(secret, now, body)).not.toBe(sign(secret, now + 1, body));
  });

  it("changes when the body or secret changes", () => {
    expect(sign(secret, now, body)).not.toBe(sign(secret, now, body + " "));
    expect(sign(secret, now, body)).not.toBe(sign("other", now, body));
  });
});

describe("verifySignature", () => {
  it("accepts a fresh, correctly signed delivery", () => {
    const signature = sign(secret, now, body);
    expect(verifySignature({ secret, timestamp: now, body, signature, now })).toBe(true);
  });

  it("rejects tampered bodies", () => {
    const signature = sign(secret, now, body);
    expect(
      verifySignature({ secret, timestamp: now, body: body + "x", signature, now }),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const signature = sign(secret, now, body);
    expect(verifySignature({ secret: "nope", timestamp: now, body, signature, now })).toBe(false);
  });

  it("rejects replays outside the tolerance window", () => {
    const signature = sign(secret, now, body);
    expect(
      verifySignature({ secret, timestamp: now, body, signature, now: now + 301 }),
    ).toBe(false);
    expect(
      verifySignature({ secret, timestamp: now, body, signature, now: now + 299 }),
    ).toBe(true);
    expect(
      verifySignature({
        secret,
        timestamp: now,
        body,
        signature,
        now: now + 10,
        toleranceSeconds: 5,
      }),
    ).toBe(false);
  });

  it("rejects malformed signatures and timestamps", () => {
    expect(verifySignature({ secret, timestamp: now, body, signature: "v1=abc", now })).toBe(false);
    expect(verifySignature({ secret, timestamp: NaN, body, signature: sign(secret, now, body), now })).toBe(false);
  });
});
