import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { createApp } from "./app";
import { AuditLog } from "../audit/audit";
import { ApiKeyService } from "../auth/apiKeys";
import { EventBus } from "../events/bus";
import { BookingService } from "../services/bookingService";
import { InMemoryStore } from "../store/store";
import { WebhookService } from "../webhooks/dispatcher";

let server: Server;
let baseUrl: string;
let adminSecret: string;
let memberSecret: string;
let viewerSecret: string;
let apiKeys: ApiKeyService;
let webhooks: WebhookService;
let posted: Array<{ url: string; body: string }>;

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json: json as any };
}

beforeAll(async () => {
  const store = new InMemoryStore();
  const bus = new EventBus();
  const audit = new AuditLog(store, bus);
  apiKeys = new ApiKeyService(store, bus);
  posted = [];
  webhooks = new WebhookService(store, bus, {
    post: async (url, init) => {
      posted.push({ url, body: init.body });
      return { status: 200 };
    },
    sleep: async () => undefined,
  });
  const service = new BookingService(store, bus);

  adminSecret = apiKeys.issue({ name: "root", role: "admin" }, null).secret;
  const admin = apiKeys.authenticate(adminSecret);
  memberSecret = apiKeys.issue({ name: "member", role: "member" }, admin).secret;
  viewerSecret = apiKeys.issue({ name: "viewer", role: "viewer" }, admin).secret;

  const app = createApp({ service, apiKeys, audit, webhooks });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await webhooks.drain();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("authentication", () => {
  it("leaves /health open", async () => {
    const res = await call("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok" });
  });

  it("rejects requests without a token", async () => {
    const res = await call("GET", "/resources");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.json.error).toMatch(/Authorization/);
  });

  it("rejects unknown and non-bearer tokens", async () => {
    expect((await call("GET", "/resources", { token: "bk_nope" })).status).toBe(401);
    const basic = await call("GET", "/resources", {
      headers: { authorization: "Basic abc" },
    });
    expect(basic.status).toBe(401);
  });

  it("identifies the caller on /auth/whoami", async () => {
    const res = await call("GET", "/auth/whoami", { token: memberSecret });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: "member", role: "member" });
  });

  it("accepts the X-Api-Key header and api_key query parameter", async () => {
    const header = await call("GET", "/auth/whoami", {
      headers: { "x-api-key": memberSecret },
    });
    expect(header.status).toBe(200);
    expect(header.json.role).toBe("member");

    const query = await call("GET", `/auth/whoami?api_key=${memberSecret}`);
    expect(query.status).toBe(200);
    expect(query.json.role).toBe("member");
  });

  it("issues scoped and expiring keys and enforces the scopes", async () => {
    const issued = await call("POST", "/auth/keys", {
      token: adminSecret,
      body: { name: "signage", role: "member", scopes: ["bookings:read"], expiresInDays: 30 },
    });
    expect(issued.status).toBe(201);
    expect(issued.json.key.scopes).toEqual(["bookings:read"]);
    expect(issued.json.key.expiresAt).toBeTruthy();

    const me = await call("GET", "/auth/whoami", { token: issued.json.secret });
    expect(me.json.scopes).toEqual(["bookings:read"]);

    expect((await call("GET", "/bookings", { token: issued.json.secret })).status).toBe(200);
    const denied = await call("POST", "/resources", {
      token: issued.json.secret,
      body: { name: "nope" },
    });
    expect(denied.status).toBe(403);

    const tooBroad = await call("POST", "/auth/keys", {
      token: adminSecret,
      body: { name: "x", role: "viewer", scopes: ["keys:manage"] },
    });
    expect(tooBroad.status).toBe(401);
  });

  it("rotates a key and keeps the old secret working during the grace window", async () => {
    const issued = await call("POST", "/auth/keys", {
      token: adminSecret,
      body: { name: "bot", role: "service" },
    });
    expect(issued.status).toBe(201);

    const rotated = await call("POST", `/auth/keys/${issued.json.key.id}/rotate`, {
      token: issued.json.secret,
    });
    expect(rotated.status).toBe(201);
    expect(rotated.json.secret).not.toBe(issued.json.secret);
    expect(rotated.json.key.rotatedAt).toBeTruthy();

    expect((await call("GET", "/auth/whoami", { token: rotated.json.secret })).status).toBe(200);
    expect((await call("GET", "/auth/whoami", { token: issued.json.secret })).status).toBe(200);

    const denied = await call("POST", `/auth/keys/${issued.json.key.id}/rotate`, {
      token: memberSecret,
    });
    expect(denied.status).toBe(403);

    const fetched = await call("GET", `/auth/keys/${issued.json.key.id}`, { token: adminSecret });
    expect(fetched.status).toBe(200);
    expect(fetched.json.prefix).toBe(rotated.json.key.prefix);
    expect(fetched.json.secretHash).toBeUndefined();
  });

  it("rejects a revoked key", async () => {
    const issued = await call("POST", "/auth/keys", {
      token: adminSecret,
      body: { name: "temp", role: "viewer" },
    });
    expect(issued.status).toBe(201);
    expect((await call("GET", "/auth/whoami", { token: issued.json.secret })).status).toBe(200);

    const revoked = await call("DELETE", `/auth/keys/${issued.json.key.id}`, {
      token: adminSecret,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.json.revokedAt).toBeTruthy();

    const after = await call("GET", "/auth/whoami", { token: issued.json.secret });
    expect(after.status).toBe(401);
    expect(after.json.error).toMatch(/revoked/);
  });
});

describe("authorization", () => {
  it("forbids members from managing keys", async () => {
    const res = await call("POST", "/auth/keys", {
      token: memberSecret,
      body: { name: "x", role: "admin" },
    });
    expect(res.status).toBe(403);
  });

  it("forbids viewers from writing", async () => {
    const res = await call("POST", "/resources", {
      token: viewerSecret,
      body: { name: "Room V" },
    });
    expect(res.status).toBe(403);
  });

  it("forbids members from reading the audit log or webhooks", async () => {
    expect((await call("GET", "/audit", { token: memberSecret })).status).toBe(403);
    expect((await call("GET", "/webhooks", { token: memberSecret })).status).toBe(403);
  });
});

describe("bookings end to end", () => {
  let roomId: string;

  beforeEach(async () => {
    const res = await call("POST", "/resources", {
      token: adminSecret,
      body: { name: `Room ${Math.random()}` },
    });
    expect(res.status).toBe(201);
    roomId = res.json.id;
  });

  it("creates, lists and cancels a booking with ownership enforced", async () => {
    const created = await call("POST", "/bookings", {
      token: memberSecret,
      body: {
        resourceId: roomId,
        bookedBy: "Ada",
        start: "2026-08-01T09:00:00Z",
        end: "2026-08-01T10:00:00Z",
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.createdBy).toBeTruthy();

    const listed = await call("GET", `/bookings?resourceId=${roomId}`, { token: viewerSecret });
    expect(listed.status).toBe(200);
    expect(listed.json).toHaveLength(1);

    // A different member cannot cancel it.
    const other = await call("POST", "/auth/keys", {
      token: adminSecret,
      body: { name: "other", role: "member" },
    });
    const denied = await call("DELETE", `/bookings/${created.json.id}`, {
      token: other.json.secret,
    });
    expect(denied.status).toBe(403);

    // The creator can.
    const cancelled = await call("DELETE", `/bookings/${created.json.id}`, {
      token: memberSecret,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.status).toBe("cancelled");
  });

  it("maps domain errors to status codes", async () => {
    const missing = await call("POST", "/bookings", {
      token: memberSecret,
      body: { resourceId: "nope", bookedBy: "Ada", start: "2026-08-01T09:00:00Z", end: "2026-08-01T10:00:00Z" },
    });
    expect(missing.status).toBe(404);

    const inverted = await call("POST", "/bookings", {
      token: memberSecret,
      body: { resourceId: roomId, bookedBy: "Ada", start: "2026-08-01T10:00:00Z", end: "2026-08-01T09:00:00Z" },
    });
    expect(inverted.status).toBe(400);

    const first = await call("POST", "/bookings", {
      token: memberSecret,
      body: { resourceId: roomId, bookedBy: "Ada", start: "2026-08-02T09:00:00Z", end: "2026-08-02T10:00:00Z" },
    });
    expect(first.status).toBe(201);
    const clash = await call("POST", "/bookings", {
      token: memberSecret,
      body: { resourceId: roomId, bookedBy: "Bob", start: "2026-08-02T09:30:00Z", end: "2026-08-02T10:30:00Z" },
    });
    expect(clash.status).toBe(409);
  });

  it("rejects malformed JSON with a 400", async () => {
    const res = await fetch(`${baseUrl}/bookings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${memberSecret}`,
        "content-type": "application/json",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Malformed JSON body");
  });

  it("serves utilization reports in json, csv and markdown", async () => {
    await call("POST", "/bookings", {
      token: memberSecret,
      body: { resourceId: roomId, bookedBy: "Ada", start: "2026-08-05T09:00:00Z", end: "2026-08-05T12:00:00Z" },
    });
    const window = "from=2026-08-05T00:00:00Z&to=2026-08-06T00:00:00Z";

    const json = await call("GET", `/reports/utilization?${window}`, { token: viewerSecret });
    expect(json.status).toBe(200);
    expect(json.json.resources.some((r: any) => r.resourceId === roomId && r.bookedMinutes === 180)).toBe(true);

    const csv = await call("GET", `/reports/utilization?${window}&format=csv`, { token: viewerSecret });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.split("\r\n")[0]).toContain("resourceId");

    const md = await call("GET", `/reports/utilization?${window}&format=md`, { token: viewerSecret });
    expect(md.status).toBe(200);
    expect(md.text).toContain("| Resource |");

    const bad = await call("GET", "/reports/utilization?from=x&to=y", { token: viewerSecret });
    expect(bad.status).toBe(400);
  });
});

describe("audit log", () => {
  it("records mutations with the acting key and supports filters", async () => {
    const me = await call("GET", "/auth/whoami", { token: memberSecret });
    const room = await call("POST", "/resources", { token: adminSecret, body: { name: "Audit Room" } });
    const booking = await call("POST", "/bookings", {
      token: memberSecret,
      body: { resourceId: room.json.id, bookedBy: "Ada", start: "2026-09-01T09:00:00Z", end: "2026-09-01T10:00:00Z" },
    });

    const all = await call("GET", "/audit?limit=5", { token: adminSecret });
    expect(all.status).toBe(200);
    expect(all.json.entries[0]).toMatchObject({
      action: "booking.created",
      subjectId: booking.json.id,
      actorKeyId: me.json.keyId,
    });

    const filtered = await call("GET", `/audit?subjectId=${room.json.id}`, { token: adminSecret });
    expect(filtered.json.total).toBe(1);
    expect(filtered.json.entries[0].action).toBe("resource.created");

    const unknown = await call("GET", "/audit?action=nope", { token: adminSecret });
    expect(unknown.status).toBe(400);
  });
});

describe("webhooks", () => {
  it("registers, delivers, lists deliveries and removes", async () => {
    const registered = await call("POST", "/webhooks", {
      token: adminSecret,
      body: { url: "https://receiver.test/hook", events: ["booking.created"] },
    });
    expect(registered.status).toBe(201);
    const hookId = registered.json.id;

    const room = await call("POST", "/resources", { token: adminSecret, body: { name: "Hook Room" } });
    const booking = await call("POST", "/bookings", {
      token: memberSecret,
      body: { resourceId: room.json.id, bookedBy: "Ada", start: "2026-09-02T09:00:00Z", end: "2026-09-02T10:00:00Z" },
    });
    await webhooks.drain();

    const mine = posted.filter((p) => p.url === "https://receiver.test/hook");
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0].body).event.booking.id).toBe(booking.json.id);

    const deliveries = await call("GET", `/webhooks/${hookId}/deliveries`, { token: adminSecret });
    expect(deliveries.status).toBe(200);
    expect(deliveries.json).toHaveLength(1);
    expect(deliveries.json[0].status).toBe("delivered");

    const listed = await call("GET", "/webhooks", { token: adminSecret });
    expect(listed.json.some((w: any) => w.id === hookId)).toBe(true);

    expect((await call("DELETE", `/webhooks/${hookId}`, { token: adminSecret })).status).toBe(204);
    expect((await call("DELETE", `/webhooks/${hookId}`, { token: adminSecret })).status).toBe(400);
  });

  it("validates registrations", async () => {
    const res = await call("POST", "/webhooks", {
      token: adminSecret,
      body: { url: "ftp://nope" },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/http or https/);
  });
});
