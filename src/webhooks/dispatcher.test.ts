import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpPost, WebhookService } from "./dispatcher";
import { WebhookError } from "./types";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "./signing";
import { EventBus } from "../events/bus";
import { InMemoryStore } from "../store/store";
import { Actor, ForbiddenError } from "../auth/types";
import { Resource } from "../domain/types";

const admin: Actor = { keyId: "k-admin", name: "Admin", role: "admin" };
const member: Actor = { keyId: "k-member", name: "Member", role: "member" };
const room: Resource = { id: "r1", name: "Room A", capacity: 1, createdBy: "k-admin" };

type Call = Parameters<HttpPost>;

function setup(responses: Array<number | Error>) {
  const store = new InMemoryStore();
  const bus = new EventBus();
  const calls: Call[] = [];
  const post: HttpPost = vi.fn(async (url, init) => {
    calls.push([url, init]);
    const next = responses.shift() ?? 200;
    if (next instanceof Error) {
      throw next;
    }
    return { status: next };
  });
  const sleep = vi.fn(async () => undefined);
  const service = new WebhookService(store, bus, {
    post,
    sleep,
    maxAttempts: 3,
    backoffMs: 100,
    clock: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  return { store, bus, calls, post, sleep, service };
}

describe("WebhookService.register", () => {
  it("stores a webhook with a generated secret and wildcard events", () => {
    const { service } = setup([]);
    const hook = service.register({ url: "https://example.test/hooks" }, admin);
    expect(hook.url).toBe("https://example.test/hooks");
    expect(hook.events).toEqual(["*"]);
    expect(hook.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(hook.active).toBe(true);
    expect(hook.createdBy).toBe("k-admin");
  });

  it("accepts a caller-provided secret and event filter", () => {
    const { service } = setup([]);
    const hook = service.register(
      {
        url: "https://example.test/hooks",
        events: ["booking.created", "booking.created", "booking.cancelled"],
        secret: "my-very-long-shared-secret",
        description: "  slack bridge ",
      },
      admin,
    );
    expect(hook.events).toEqual(["booking.created", "booking.cancelled"]);
    expect(hook.secret).toBe("my-very-long-shared-secret");
    expect(hook.description).toBe("slack bridge");
  });

  it("rejects invalid urls, protocols, events and short secrets", () => {
    const { service } = setup([]);
    expect(() => service.register({ url: "" }, admin)).toThrow(WebhookError);
    expect(() => service.register({ url: "not a url" }, admin)).toThrow(WebhookError);
    expect(() => service.register({ url: "ftp://example.test/x" }, admin)).toThrow(/http or https/);
    expect(() => service.register({ url: "https://example.test", events: [] }, admin)).toThrow(WebhookError);
    expect(() =>
      service.register({ url: "https://example.test", events: ["nope" as never] }, admin),
    ).toThrow(/Unknown event type/);
    expect(() =>
      service.register({ url: "https://example.test", secret: "short" }, admin),
    ).toThrow(/at least 16/);
  });

  it("requires webhooks:manage", () => {
    const { service } = setup([]);
    expect(() => service.register({ url: "https://example.test" }, member)).toThrow(ForbiddenError);
    expect(() => service.list(member)).toThrow(ForbiddenError);
  });

  it("publishes lifecycle events that are never delivered to webhooks", async () => {
    const { service, bus, calls } = setup([]);
    const seen: string[] = [];
    bus.subscribe("*", (e) => seen.push(e.event.type));

    const hook = service.register({ url: "https://example.test" }, admin);
    service.remove(hook.id, admin);
    await service.drain();

    expect(seen).toEqual(["webhook.registered", "webhook.removed"]);
    expect(calls).toHaveLength(0);
    expect(() => service.remove(hook.id, admin)).toThrow(/not found/);
  });
});

describe("WebhookService delivery", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup([]);
  });

  it("posts a signed envelope to matching webhooks only", async () => {
    const hook = ctx.service.register(
      { url: "https://a.test/h", events: ["resource.created"] },
      admin,
    );
    ctx.service.register({ url: "https://b.test/h", events: ["booking.cancelled"] }, admin);

    const envelope = ctx.bus.publish({ type: "resource.created", resource: room }, admin);
    await ctx.service.drain();

    expect(ctx.calls).toHaveLength(1);
    const [url, init] = ctx.calls[0];
    expect(url).toBe("https://a.test/h");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["x-booking-event-id"]).toBe(envelope.id);
    expect(JSON.parse(init.body)).toEqual(JSON.parse(JSON.stringify(envelope)));

    const ok = verifySignature({
      secret: hook.secret,
      timestamp: Number(init.headers[TIMESTAMP_HEADER]),
      body: init.body,
      signature: init.headers[SIGNATURE_HEADER],
      now: Number(init.headers[TIMESTAMP_HEADER]),
    });
    expect(ok).toBe(true);
  });

  it("records a successful delivery", async () => {
    const hook = ctx.service.register({ url: "https://a.test/h" }, admin);
    ctx.bus.publish({ type: "resource.created", resource: room }, admin);
    await ctx.service.drain();

    const [delivery] = ctx.service.deliveries(hook.id, admin);
    expect(delivery.status).toBe("delivered");
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastStatusCode).toBe(200);
    expect(delivery.lastError).toBeNull();
    expect(delivery.completedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("retries on 5xx with exponential backoff and then succeeds", async () => {
    ctx = setup([503, 502, 200]);
    const hook = ctx.service.register({ url: "https://a.test/h" }, admin);
    ctx.bus.publish({ type: "resource.created", resource: room }, admin);
    await ctx.service.drain();

    expect(ctx.post).toHaveBeenCalledTimes(3);
    expect(ctx.sleep).toHaveBeenNthCalledWith(1, 100);
    expect(ctx.sleep).toHaveBeenNthCalledWith(2, 200);
    const [delivery] = ctx.service.deliveries(hook.id, admin);
    expect(delivery.status).toBe("delivered");
    expect(delivery.attempts).toBe(3);
  });

  it("retries on network errors and gives up after maxAttempts", async () => {
    ctx = setup([new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
    const hook = ctx.service.register({ url: "https://a.test/h" }, admin);
    ctx.bus.publish({ type: "resource.created", resource: room }, admin);
    await ctx.service.drain();

    const [delivery] = ctx.service.deliveries(hook.id, admin);
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(3);
    expect(delivery.lastError).toBe("ECONNREFUSED");
    expect(delivery.lastStatusCode).toBeNull();
  });

  it("does not retry on a non-retryable 4xx", async () => {
    ctx = setup([404]);
    const hook = ctx.service.register({ url: "https://a.test/h" }, admin);
    ctx.bus.publish({ type: "resource.created", resource: room }, admin);
    await ctx.service.drain();

    expect(ctx.post).toHaveBeenCalledTimes(1);
    const [delivery] = ctx.service.deliveries(hook.id, admin);
    expect(delivery.status).toBe("failed");
    expect(delivery.lastError).toBe("HTTP 404");
  });

  it("treats 429 as retryable", async () => {
    ctx = setup([429, 200]);
    ctx.service.register({ url: "https://a.test/h" }, admin);
    ctx.bus.publish({ type: "resource.created", resource: room }, admin);
    await ctx.service.drain();
    expect(ctx.post).toHaveBeenCalledTimes(2);
  });

  it("raises onError once per permanently failed delivery", async () => {
    const onError = vi.fn();
    const store = new InMemoryStore();
    const bus = new EventBus();
    const service = new WebhookService(store, bus, {
      post: async () => ({ status: 500 }),
      sleep: async () => undefined,
      maxAttempts: 2,
      onError,
    });
    service.register({ url: "https://a.test/h" }, admin);
    bus.publish({ type: "resource.created", resource: room }, admin);
    await service.drain();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after close()", async () => {
    ctx.service.register({ url: "https://a.test/h" }, admin);
    ctx.service.close();
    ctx.bus.publish({ type: "resource.created", resource: room }, admin);
    await ctx.service.drain();
    expect(ctx.calls).toHaveLength(0);
  });

  it("rejects delivery lookups for unknown webhooks", () => {
    expect(() => ctx.service.deliveries("nope", admin)).toThrow(WebhookError);
  });
});
