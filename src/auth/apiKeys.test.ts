import { beforeEach, describe, expect, it } from "vitest";
import {
  actorCan,
  ApiKeyService,
  digestsMatch,
  generateSecret,
  hasPermission,
  hashSecret,
  parseAuthorizationHeader,
  publicPrefix,
  resolveScopes,
  ROTATION_GRACE_HOURS,
} from "./apiKeys";
import { Actor, AuthError, ForbiddenError } from "./types";
import { InMemoryStore } from "../store/store";
import { EventBus } from "../events/bus";
import { EventEnvelope } from "../events/types";

describe("secrets", () => {
  it("generates prefixed, high-entropy secrets", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^bk_[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it("derives a short public prefix", () => {
    expect(publicPrefix("bk_abcdefghijklmnop")).toBe("bk_abcdefgh");
  });

  it("hashes deterministically", () => {
    expect(hashSecret("bk_x")).toBe(hashSecret("bk_x"));
    expect(hashSecret("bk_x")).not.toBe(hashSecret("bk_y"));
    expect(hashSecret("bk_x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compares digests safely", () => {
    const d = hashSecret("bk_x");
    expect(digestsMatch(d, d)).toBe(true);
    expect(digestsMatch(d, hashSecret("bk_y"))).toBe(false);
    expect(digestsMatch(d, d.slice(0, 10))).toBe(false);
    expect(digestsMatch("", "")).toBe(false);
  });
});

describe("parseAuthorizationHeader", () => {
  it("extracts a bearer token", () => {
    expect(parseAuthorizationHeader("Bearer bk_abc")).toBe("bk_abc");
    expect(parseAuthorizationHeader("bearer   bk_abc ")).toBe("bk_abc");
  });

  it("rejects other schemes and malformed values", () => {
    expect(parseAuthorizationHeader(undefined)).toBeNull();
    expect(parseAuthorizationHeader("")).toBeNull();
    expect(parseAuthorizationHeader("Basic abc")).toBeNull();
    expect(parseAuthorizationHeader("Bearer")).toBeNull();
    expect(parseAuthorizationHeader("Bearer a b")).toBeNull();
  });
});

describe("hasPermission", () => {
  it("grants admins everything", () => {
    expect(hasPermission("admin", "keys:manage")).toBe(true);
    expect(hasPermission("admin", "bookings:cancel:any")).toBe(true);
  });

  it("restricts members and viewers", () => {
    expect(hasPermission("member", "bookings:write")).toBe(true);
    expect(hasPermission("member", "bookings:cancel:any")).toBe(false);
    expect(hasPermission("member", "keys:manage")).toBe(false);
    expect(hasPermission("viewer", "bookings:write")).toBe(false);
    expect(hasPermission("viewer", "bookings:read")).toBe(true);
  });

  it("lets service keys reconcile bookings but not manage keys or audit", () => {
    expect(hasPermission("service", "bookings:cancel:any")).toBe(true);
    expect(hasPermission("service", "webhooks:manage")).toBe(true);
    expect(hasPermission("service", "keys:manage")).toBe(false);
    expect(hasPermission("service", "audit:read")).toBe(false);
  });
});

describe("actorCan and scopes", () => {
  it("treats missing or null scopes as the full role", () => {
    expect(actorCan({ keyId: "k", name: "x", role: "member" }, "bookings:write")).toBe(true);
    expect(
      actorCan({ keyId: "k", name: "x", role: "member", scopes: null }, "bookings:write"),
    ).toBe(true);
  });

  it("narrows a role to the listed scopes", () => {
    const actor: Actor = { keyId: "k", name: "x", role: "admin", scopes: ["bookings:read"] };
    expect(actorCan(actor, "bookings:read")).toBe(true);
    expect(actorCan(actor, "keys:manage")).toBe(false);
  });

  it("never grants beyond the role even when scoped", () => {
    expect(resolveScopes("member", ["bookings:read"])).toEqual(["bookings:read"]);
    expect(resolveScopes("member", undefined)).toBeNull();
    expect(() => resolveScopes("member", ["keys:manage"])).toThrow(/cannot be granted/);
    expect(() => resolveScopes("member", ["nope"])).toThrow(/Unknown permission/);
    expect(() => resolveScopes("member", [])).toThrow(AuthError);
  });
});

describe("ApiKeyService", () => {
  let store: InMemoryStore;
  let bus: EventBus;
  let service: ApiKeyService;
  let published: EventEnvelope[];
  let admin: Actor;

  beforeEach(() => {
    store = new InMemoryStore();
    bus = new EventBus();
    published = [];
    bus.subscribe("*", (e) => published.push(e));
    service = new ApiKeyService(store, bus, () => new Date("2026-09-01T00:00:00.000Z"));
    const root = service.issue({ name: "root", role: "admin" }, null);
    admin = service.authenticate(root.secret);
  });

  it("issues a key whose secret authenticates to the right actor", () => {
    const issued = service.issue({ name: "ci", role: "member" }, admin);
    const actor = service.authenticate(issued.secret);
    expect(actor).toEqual({ keyId: issued.key.id, name: "ci", role: "member", scopes: null });
    expect(issued.key.prefix).toBe(publicPrefix(issued.secret));
    expect(issued.key.createdBy).toBe(admin.keyId);
  });

  it("never persists or returns the plaintext secret", () => {
    const issued = service.issue({ name: "ci", role: "member" }, admin);
    const stored = store.getApiKey(issued.key.id)!;
    expect(stored.secretHash).toBe(hashSecret(issued.secret));
    expect(JSON.stringify(stored)).not.toContain(issued.secret);
    expect(JSON.stringify(service.list(admin))).not.toContain("secretHash");
  });

  it("rejects unknown secrets", () => {
    expect(() => service.authenticate("bk_nope")).toThrow(AuthError);
    expect(() => service.authenticate("")).toThrow(AuthError);
  });

  it("records last use on authentication", () => {
    const issued = service.issue({ name: "ci", role: "member" }, admin);
    expect(store.getApiKey(issued.key.id)!.lastUsedAt).toBeNull();
    service.authenticate(issued.secret);
    expect(store.getApiKey(issued.key.id)!.lastUsedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("refuses revoked keys and is idempotent on revoke", () => {
    const issued = service.issue({ name: "ci", role: "member" }, admin);
    const revoked = service.revoke(issued.key.id, admin);
    expect(revoked.revokedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(() => service.authenticate(issued.secret)).toThrow(/revoked/);
    expect(service.revoke(issued.key.id, admin)).toEqual(revoked);
    expect(published.filter((e) => e.event.type === "apikey.revoked")).toHaveLength(1);
  });

  it("does not let a key revoke itself", () => {
    expect(() => service.revoke(admin.keyId, admin)).toThrow(ForbiddenError);
  });

  it("only admins may issue, list or revoke keys", () => {
    const issued = service.issue({ name: "ci", role: "member" }, admin);
    const member = service.authenticate(issued.secret);
    expect(() => service.issue({ name: "x", role: "viewer" }, member)).toThrow(ForbiddenError);
    expect(() => service.list(member)).toThrow(ForbiddenError);
    expect(() => service.revoke(admin.keyId, member)).toThrow(ForbiddenError);
  });

  it("validates issue input", () => {
    expect(() => service.issue({ name: "  ", role: "member" }, admin)).toThrow(AuthError);
    expect(() =>
      service.issue({ name: "x", role: "superuser" as unknown as "admin" }, admin),
    ).toThrow(/Unknown role/);
  });

  it("seeds a deterministic secret exactly once", () => {
    const secret = "bk_seeded_secret_for_tests_0001";
    const first = service.seed(secret, { name: "bootstrap", role: "admin" });
    const second = service.seed(secret, { name: "bootstrap", role: "admin" });
    expect(second.id).toBe(first.id);
    expect(service.authenticate(secret).role).toBe("admin");
  });

  it("rejects weak seeded secrets", () => {
    expect(() => service.seed("bk_short", { name: "x", role: "admin" })).toThrow(AuthError);
    expect(() =>
      service.seed("nope_but_long_enough_secret_value", { name: "x", role: "admin" }),
    ).toThrow(AuthError);
  });

  it("issues scoped keys whose actor carries the scopes", () => {
    const issued = service.issue(
      { name: "signage", role: "member", scopes: ["bookings:read", "resources:read"] },
      admin,
    );
    const actor = service.authenticate(issued.secret);
    expect(actor.scopes).toEqual(["bookings:read", "resources:read"]);
    expect(actorCan(actor, "bookings:write")).toBe(false);
    expect(() =>
      service.issue({ name: "bad", role: "viewer", scopes: ["bookings:write"] }, admin),
    ).toThrow(AuthError);
  });

  it("expires keys after expiresInDays", () => {
    let now = new Date("2026-09-01T00:00:00.000Z");
    const clocked = new ApiKeyService(store, bus, () => now);
    const issued = clocked.issue({ name: "temp", role: "viewer", expiresInDays: 7 }, admin);
    expect(issued.key.expiresAt).toBe("2026-09-08T00:00:00.000Z");
    expect(clocked.authenticate(issued.secret).role).toBe("viewer");

    now = new Date("2026-09-08T00:00:00.000Z");
    expect(() => clocked.authenticate(issued.secret)).toThrow(/expired/);
  });

  it("validates expiresInDays", () => {
    expect(() => service.issue({ name: "x", role: "viewer", expiresInDays: 0 }, admin)).toThrow(
      AuthError,
    );
    expect(() =>
      service.issue({ name: "x", role: "viewer", expiresInDays: 1.5 }, admin),
    ).toThrow(AuthError);
    expect(() =>
      service.issue({ name: "x", role: "viewer", expiresInDays: 9999 }, admin),
    ).toThrow(AuthError);
  });

  it("rotates a secret and honours the grace window for the old one", () => {
    let now = new Date("2026-09-01T00:00:00.000Z");
    const clocked = new ApiKeyService(store, bus, () => now);
    const issued = clocked.issue({ name: "bot", role: "service" }, admin);
    const before = clocked.authenticate(issued.secret);

    published.length = 0;
    const rotated = clocked.rotate(issued.key.id, admin);
    expect(rotated.secret).not.toBe(issued.secret);
    expect(rotated.key.id).toBe(issued.key.id);
    expect(rotated.key.prefix).toBe(publicPrefix(rotated.secret));
    expect(rotated.key.rotatedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(JSON.stringify(rotated.key)).not.toContain("SecretHash");
    expect(published.map((e) => e.event.type)).toEqual(["apikey.rotated"]);

    // Both secrets work during the grace period and resolve to the same key.
    expect(clocked.authenticate(rotated.secret).keyId).toBe(before.keyId);
    expect(clocked.authenticate(issued.secret).keyId).toBe(before.keyId);

    now = new Date(now.getTime() + ROTATION_GRACE_HOURS * 60 * 60 * 1000);
    expect(() => clocked.authenticate(issued.secret)).toThrow(/Invalid API key/);
    expect(clocked.authenticate(rotated.secret).keyId).toBe(before.keyId);
  });

  it("lets a key rotate itself but not other keys", () => {
    const issued = service.issue({ name: "bot", role: "member" }, admin);
    const other = service.issue({ name: "other", role: "member" }, admin);
    const bot = service.authenticate(issued.secret);

    const rotated = service.rotate(issued.key.id, bot);
    expect(service.authenticate(rotated.secret).keyId).toBe(bot.keyId);
    expect(() => service.rotate(other.key.id, bot)).toThrow(ForbiddenError);
  });

  it("refuses to rotate revoked or unknown keys", () => {
    const issued = service.issue({ name: "bot", role: "member" }, admin);
    service.revoke(issued.key.id, admin);
    expect(() => service.rotate(issued.key.id, admin)).toThrow(ForbiddenError);
    expect(() => service.rotate("missing", admin)).toThrow(AuthError);
  });

  it("publishes apikey.issued for every new key", () => {
    published.length = 0;
    const issued = service.issue({ name: "ci", role: "viewer" }, admin);
    expect(published).toHaveLength(1);
    expect(published[0].event).toEqual({
      type: "apikey.issued",
      keyId: issued.key.id,
      role: "viewer",
    });
  });
});
