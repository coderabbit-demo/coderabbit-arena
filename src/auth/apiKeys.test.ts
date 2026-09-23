import { beforeEach, describe, expect, it } from "vitest";
import {
  ApiKeyService,
  digestsMatch,
  generateSecret,
  hasPermission,
  hashSecret,
  parseAuthorizationHeader,
  publicPrefix,
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
    expect(actor).toEqual({ keyId: issued.key.id, name: "ci", role: "member" });
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
