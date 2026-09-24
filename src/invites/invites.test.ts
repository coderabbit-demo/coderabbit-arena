import { beforeEach, describe, expect, it } from "vitest";
import {
  generateToken,
  InviteError,
  InviteService,
  signToken,
  toPublicInvite,
  verifyToken,
} from "./invites";
import { ApiKeyService } from "../auth/apiKeys";
import { EventBus } from "../events/bus";
import { InMemoryStore } from "../store/store";
import { Actor } from "../auth/types";

const admin: Actor = { keyId: "k-admin", name: "Admin", role: "admin" };
const member: Actor = { keyId: "k-member", name: "Member", role: "member" };
const SECRET = "test-secret";

let store: InMemoryStore;
let bus: EventBus;
let apiKeys: ApiKeyService;
let invites: InviteService;
let now: Date;

beforeEach(() => {
  store = new InMemoryStore();
  bus = new EventBus();
  now = new Date("2026-09-20T12:00:00.000Z");
  const clock = () => now;
  apiKeys = new ApiKeyService(store, bus, clock);
  invites = new InviteService(store, apiKeys, bus, { secret: SECRET, ttlHours: 48, clock });
});

describe("tokens", () => {
  it("generates distinct tokens", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(seen.size).toBe(50);
  });

  it("round-trips through sign/verify", () => {
    const token = generateToken();
    const signed = signToken(token, SECRET);
    expect(verifyToken(signed, SECRET)).toBe(token);
  });

  it("rejects tampered or foreign tokens", () => {
    const signed = signToken("abc", SECRET);
    expect(verifyToken(signed, "other")).toBeNull();
    expect(verifyToken(`${signed}x`, SECRET)).toBeNull();
    expect(verifyToken("no-dot", SECRET)).toBeNull();
  });
});

describe("InviteService.create", () => {
  it("creates an invite with the requested role and expiry", () => {
    const invite = invites.create({ email: "Ada@Example.com", role: "viewer" }, admin);
    expect(invite.email).toBe("ada@example.com");
    expect(invite.role).toBe("viewer");
    expect(invite.createdBy).toBe("k-admin");
    expect(invite.acceptedAt).toBeNull();
    expect(new Date(invite.expiresAt).getTime()).toBeGreaterThan(now.getTime());
    expect(verifyToken(invite.token, SECRET)).not.toBeNull();
  });

  it("defaults to the member role", () => {
    expect(invites.create({ email: "a@b.c" }, admin).role).toBe("member");
  });

  it("publishes invite.created with the token so it can be emailed", () => {
    const events: unknown[] = [];
    bus.subscribe("invite.created", (e) => events.push(e.event));
    const invite = invites.create({ email: "a@b.c" }, admin);
    expect(events).toEqual([
      expect.objectContaining({ inviteId: invite.id, token: invite.token }),
    ]);
  });

  it("rejects invalid emails and roles", () => {
    expect(() => invites.create({ email: "nope" }, admin)).toThrow(InviteError);
    expect(() => invites.create({ email: "a@b.c", role: "owner" as never }, admin)).toThrow(
      /Unknown role/,
    );
  });

  it("members cannot invite", () => {
    expect(() => invites.create({ email: "a@b.c" }, member)).toThrow(/not allowed/);
  });
});

describe("InviteService.accept", () => {
  it("issues a key with the invited role and marks the invite used", () => {
    const invite = invites.create({ email: "ada@example.com", role: "member" }, admin);
    const issued = invites.accept(invite.token, { name: "Ada" });
    expect(issued.key.role).toBe("member");
    expect(issued.key.name).toBe("Ada");
    expect(issued.secret.startsWith("bk_")).toBe(true);
    expect(store.getInvite(invite.id)?.acceptedAt).toBe(now.toISOString());
    expect(store.getInvite(invite.id)?.keyId).toBe(issued.key.id);
    expect(apiKeys.authenticate(issued.secret).role).toBe("member");
  });

  it("uses the email as the key name when none is given", () => {
    const invite = invites.create({ email: "ada@example.com" }, admin);
    expect(invites.accept(invite.token, {}).key.name).toBe("ada@example.com");
  });

  it("lets the invitee pick a role", () => {
    const invite = invites.create({ email: "ada@example.com", role: "member" }, admin);
    expect(invites.accept(invite.token, { role: "viewer" }).key.role).toBe("viewer");
  });

  it("cannot be used twice", () => {
    const invite = invites.create({ email: "ada@example.com" }, admin);
    invites.accept(invite.token, {});
    expect(() => invites.accept(invite.token, {})).toThrow(/already been used/);
  });

  it("rejects expired invites", () => {
    const invite = invites.create({ email: "ada@example.com" }, admin);
    now = new Date("2026-09-30T12:00:00.000Z");
    expect(() => invites.accept(invite.token, {})).toThrow(/expired/);
  });

  it("rejects unknown and malformed tokens", () => {
    expect(() => invites.accept("garbage", {})).toThrow(/Invalid invitation/);
    expect(() => invites.accept(signToken("unknown", SECRET), {})).toThrow(/Invalid invitation/);
  });

  it("publishes invite.accepted attributed to the new key", () => {
    const actors: unknown[] = [];
    bus.subscribe("invite.accepted", (e) => actors.push(e.actor));
    const invite = invites.create({ email: "ada@example.com" }, admin);
    const issued = invites.accept(invite.token, {});
    expect(actors).toEqual([expect.objectContaining({ keyId: issued.key.id })]);
  });
});

describe("InviteService.inspect / list / revoke / resend", () => {
  it("inspects without revealing the token", () => {
    const invite = invites.create({ email: "ada@example.com" }, admin);
    const shown = invites.inspect(invite.token);
    expect(shown).not.toHaveProperty("token");
    expect(shown.email).toBe("ada@example.com");
  });

  it("toPublicInvite strips the token", () => {
    const invite = invites.create({ email: "ada@example.com" }, admin);
    expect(Object.keys(toPublicInvite(invite))).not.toContain("token");
  });

  it("lists invites for admins", () => {
    invites.create({ email: "a@b.c" }, admin);
    invites.create({ email: "d@e.f" }, admin);
    expect(invites.list(admin)).toHaveLength(2);
    expect(() => invites.list(member)).toThrow(/not allowed/);
  });

  it("revokes pending invites", () => {
    const invite = invites.create({ email: "a@b.c" }, admin);
    const revoked = invites.revoke(invite.id, admin);
    expect(revoked.expiresAt).toBe(now.toISOString());
    now = new Date(now.getTime() + 1000);
    expect(() => invites.accept(invite.token, {})).toThrow(/expired/);
  });

  it("refuses to revoke accepted invites", () => {
    const invite = invites.create({ email: "a@b.c" }, admin);
    invites.accept(invite.token, {});
    expect(() => invites.revoke(invite.id, admin)).toThrow(/revoke the key/);
  });

  it("resends as a fresh invite", () => {
    const invite = invites.create({ email: "a@b.c", role: "viewer" }, admin);
    const again = invites.resend(invite.id, admin);
    expect(again.id).not.toBe(invite.id);
    expect(again.token).not.toBe(invite.token);
    expect(again.role).toBe("viewer");
  });
});
