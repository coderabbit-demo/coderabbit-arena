import { describe, expect, it } from "vitest";
import { clientKey, RateLimiter, RateLimitError } from "./rateLimit";

function limiter(limit: number, start = 0) {
  let now = start;
  const rl = new RateLimiter({ limit, windowMs: 1000, clock: () => now });
  return { rl, tick: (ms: number) => (now += ms) };
}

describe("RateLimiter.hit", () => {
  it("counts down remaining requests", () => {
    const { rl } = limiter(3);
    expect(rl.hit("a").remaining).toBe(2);
    expect(rl.hit("a").remaining).toBe(1);
    expect(rl.hit("a").remaining).toBe(0);
  });

  it("throws once the limit is exhausted", () => {
    const { rl } = limiter(2);
    rl.hit("a");
    rl.hit("a");
    rl.hit("a");
    expect(() => rl.hit("a")).toThrow(RateLimitError);
  });

  it("reports how long to wait", () => {
    const { rl, tick } = limiter(1, 0);
    rl.hit("a");
    rl.hit("a");
    tick(250);
    try {
      rl.hit("a");
      expect.fail("expected throw");
    } catch (err) {
      expect((err as RateLimitError).retryAfterSeconds).toBe(1);
    }
  });

  it("resets after the window", () => {
    const { rl, tick } = limiter(1);
    rl.hit("a");
    rl.hit("a");
    tick(1001);
    expect(rl.hit("a").remaining).toBe(0);
  });

  it("tracks clients independently", () => {
    const { rl } = limiter(1);
    rl.hit("a");
    rl.hit("a");
    expect(() => rl.hit("b")).not.toThrow();
    expect(rl.size()).toBe(2);
  });
});

describe("clientKey", () => {
  it("prefers the first forwarded address", () => {
    const req = {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    } as never;
    expect(clientKey(req)).toBe("203.0.113.5");
  });

  it("falls back to the socket address", () => {
    const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" } } as never;
    expect(clientKey(req)).toBe("10.0.0.1");
  });

  it("handles array headers", () => {
    const req = { headers: { "x-forwarded-for": ["1.1.1.1"] }, socket: {} } as never;
    expect(clientKey(req)).toBe("1.1.1.1");
  });
});

describe("RateLimiter.middleware", () => {
  function fakeReqRes(path = "/bookings") {
    const headers: Record<string, string> = {};
    const req = { path, headers: {}, socket: { remoteAddress: "1.2.3.4" } } as never;
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as never;
    return { req, res, headers };
  }

  it("sets rate limit headers", () => {
    const { rl } = limiter(5);
    const { req, res, headers } = fakeReqRes();
    let called: unknown = "not called";
    rl.middleware()(req, res, (err?: unknown) => (called = err));
    expect(called).toBeUndefined();
    expect(headers["X-RateLimit-Limit"]).toBe("5");
    expect(headers["X-RateLimit-Remaining"]).toBe("4");
  });

  it("skips configured paths", () => {
    const rl = new RateLimiter({ limit: 0, skip: ["/health"] });
    const { req, res } = fakeReqRes("/health");
    let called: unknown = "not called";
    rl.middleware()(req, res, (err?: unknown) => (called = err));
    expect(called).toBeUndefined();
    expect(rl.size()).toBe(0);
  });

  it("passes a RateLimitError to next when exhausted", () => {
    const { rl } = limiter(0);
    const { req, res, headers } = fakeReqRes();
    rl.middleware()(req, res, () => undefined);
    let err: unknown;
    rl.middleware()(req, res, (e?: unknown) => (err = e));
    expect(err).toBeInstanceOf(RateLimitError);
    expect(headers["Retry-After"]).toBeDefined();
  });
});
