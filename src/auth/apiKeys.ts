import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { EventBus } from "../events/bus";
import {
  Actor,
  ApiKey,
  AuthError,
  ForbiddenError,
  IssueKeyInput,
  IssuedKey,
  Permission,
  PublicApiKey,
  Role,
} from "./types";

/** All issued secrets start with this so they are easy to spot in logs and scanners. */
export const KEY_PREFIX = "bk";
/** Number of random bytes behind each secret (24 bytes → 32 base64url chars). */
const SECRET_BYTES = 24;
/** Characters of the secret (after the prefix) kept as the public, searchable prefix. */
const PUBLIC_PREFIX_CHARS = 8;

const ROLES: readonly Role[] = ["admin", "member", "viewer"];

/**
 * Permission matrix. Admins can do everything; members can manage bookings
 * they own and read most things; viewers are read-only.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: [
    "resources:read",
    "resources:write",
    "bookings:read",
    "bookings:write",
    "bookings:cancel:any",
    "reports:read",
    "keys:manage",
    "webhooks:manage",
    "audit:read",
  ],
  member: ["resources:read", "bookings:read", "bookings:write", "reports:read"],
  viewer: ["resources:read", "bookings:read", "reports:read"],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Throw a ForbiddenError unless `actor` holds `permission`. */
export function assertPermission(actor: Actor, permission: Permission): void {
  if (!hasPermission(actor.role, permission)) {
    throw new ForbiddenError(
      `Role "${actor.role}" is not allowed to perform ${permission}`,
    );
  }
}

/** Hex-encoded SHA-256 of a secret. Keys are high-entropy so no salt is needed. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Generate a fresh bearer secret, e.g. "bk_Qm9va2luZ0FQSSBpcyBncmVhdA". */
export function generateSecret(): string {
  return `${KEY_PREFIX}_${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

/** The non-secret prefix of a secret used for display, e.g. "bk_Qm9va2lu". */
export function publicPrefix(secret: string): string {
  const body = secret.startsWith(`${KEY_PREFIX}_`)
    ? secret.slice(KEY_PREFIX.length + 1)
    : secret;
  return `${KEY_PREFIX}_${body.slice(0, PUBLIC_PREFIX_CHARS)}`;
}

/**
 * Constant-time comparison of two hex digests. Lengths are compared first
 * because timingSafeEqual throws on mismatched buffer sizes.
 */
export function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract the bearer token from an Authorization header. Returns null when the
 * header is missing or not a Bearer scheme.
 */
export function parseAuthorizationHeader(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) {
    return null;
  }
  return rest[0] || null;
}

/** Persistence needed by the key service; implemented by the main store. */
export interface ApiKeyStore {
  addApiKey(key: ApiKey): ApiKey;
  getApiKey(id: string): ApiKey | undefined;
  listApiKeys(): ApiKey[];
  updateApiKey(key: ApiKey): ApiKey;
}

export function toPublicKey(key: ApiKey): PublicApiKey {
  const { secretHash: _hash, ...rest } = key;
  return rest;
}

/**
 * Issues, revokes and authenticates API keys. Secrets are only ever held in
 * memory long enough to hash them.
 */
export class ApiKeyService {
  constructor(
    private readonly store: ApiKeyStore,
    private readonly bus: EventBus,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Issue a new key. Only admins may issue keys; bootstrap passes `null`. */
  issue(input: IssueKeyInput, issuedBy: Actor | null): IssuedKey {
    if (issuedBy) {
      assertPermission(issuedBy, "keys:manage");
    }
    const secret = generateSecret();
    const key = this.persist(secret, input, issuedBy?.keyId ?? null);
    return { key: toPublicKey(key), secret };
  }

  /**
   * Register a caller-supplied secret, used to seed a deterministic admin key
   * from configuration at start-up. The secret must carry the standard prefix
   * and be reasonably long so weak bootstrap keys are rejected early.
   */
  seed(secret: string, input: IssueKeyInput): PublicApiKey {
    if (!secret.startsWith(`${KEY_PREFIX}_`) || secret.length < 24) {
      throw new AuthError(
        `Seeded secrets must start with "${KEY_PREFIX}_" and be at least 24 characters`,
      );
    }
    const digest = hashSecret(secret);
    const existing = this.store
      .listApiKeys()
      .find((k) => digestsMatch(k.secretHash, digest));
    if (existing) {
      return toPublicKey(existing);
    }
    return toPublicKey(this.persist(secret, input, null));
  }

  revoke(id: string, actor: Actor): PublicApiKey {
    assertPermission(actor, "keys:manage");
    const key = this.store.getApiKey(id);
    if (!key) {
      throw new AuthError(`API key not found: ${id}`);
    }
    if (key.id === actor.keyId) {
      throw new ForbiddenError("An API key cannot revoke itself");
    }
    if (key.revokedAt) {
      return toPublicKey(key);
    }
    const revoked = this.store.updateApiKey({
      ...key,
      revokedAt: this.clock().toISOString(),
    });
    this.bus.publish({ type: "apikey.revoked", keyId: revoked.id }, actor);
    return toPublicKey(revoked);
  }

  list(actor: Actor): PublicApiKey[] {
    assertPermission(actor, "keys:manage");
    return this.store.listApiKeys().map(toPublicKey);
  }

  /**
   * Resolve a bearer secret to an Actor. Every stored hash is compared in
   * constant time and the loop always runs to completion so a valid prefix
   * cannot be distinguished from an invalid one by response time.
   */
  authenticate(secret: string): Actor {
    const digest = hashSecret(secret);
    let match: ApiKey | undefined;
    for (const key of this.store.listApiKeys()) {
      if (digestsMatch(key.secretHash, digest)) {
        match = key;
      }
    }
    if (!match) {
      throw new AuthError("Invalid API key");
    }
    if (match.revokedAt) {
      throw new AuthError("API key has been revoked");
    }
    this.store.updateApiKey({ ...match, lastUsedAt: this.clock().toISOString() });
    return { keyId: match.id, name: match.name, role: match.role };
  }

  private persist(secret: string, input: IssueKeyInput, createdBy: string | null): ApiKey {
    const name = input.name?.trim();
    if (!name) {
      throw new AuthError("Key name is required");
    }
    if (!isRole(input.role)) {
      throw new AuthError(`Unknown role: ${String(input.role)}`);
    }
    const key = this.store.addApiKey({
      id: randomUUID(),
      prefix: publicPrefix(secret),
      secretHash: hashSecret(secret),
      name,
      role: input.role,
      createdAt: this.clock().toISOString(),
      createdBy,
      revokedAt: null,
      lastUsedAt: null,
    });
    this.bus.publish(
      { type: "apikey.issued", keyId: key.id, role: key.role },
      createdBy ? { keyId: createdBy, name: "", role: "admin" } : null,
    );
    return key;
  }
}
