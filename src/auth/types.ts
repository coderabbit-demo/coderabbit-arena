/**
 * Coarse-grained roles attached to an API key. `service` is meant for
 * machine-to-machine integrations (calendar sync, signage, bots) that need to
 * act on bookings regardless of who created them.
 */
export type Role = "admin" | "member" | "viewer" | "service";

/**
 * Fine-grained permissions. Roles map onto a fixed set of permissions (see
 * `ROLE_PERMISSIONS`) so route handlers never branch on role names directly.
 * A key may additionally be narrowed to a subset of its role's permissions
 * through `scopes`.
 */
export type Permission =
  | "resources:read"
  | "resources:write"
  | "bookings:read"
  | "bookings:write"
  | "bookings:cancel:any"
  | "reports:read"
  | "keys:manage"
  | "webhooks:manage"
  | "audit:read";

/** A persisted API key. The secret itself is never stored, only its hash. */
export interface ApiKey {
  id: string;
  /** Short, non-secret prefix of the key shown in listings, e.g. "bk_3f9a2c1d". */
  prefix: string;
  /** Hex-encoded SHA-256 digest of the full secret. */
  secretHash: string;
  /**
   * Digest of the secret that was active before the last rotation. Stays
   * valid until `previousSecretExpiresAt` so clients can roll over gradually.
   */
  previousSecretHash: string | null;
  previousSecretExpiresAt: string | null;
  /** Human-readable label, e.g. "CI deploy bot". */
  name: string;
  role: Role;
  /**
   * Optional narrowing of the role's permissions. `null` means the key holds
   * every permission of its role.
   */
  scopes: Permission[] | null;
  createdAt: string;
  /** Id of the key that issued this one, or null for bootstrap keys. */
  createdBy: string | null;
  /** ISO-8601 instant after which the key no longer authenticates, or null. */
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** When the secret was last rotated, or null if never. */
  rotatedAt: string | null;
}

/** The safe-to-return projection of an API key (no hashes). */
export type PublicApiKey = Omit<ApiKey, "secretHash" | "previousSecretHash">;

/** Who is performing an action, resolved from a valid API key. */
export interface Actor {
  keyId: string;
  name: string;
  role: Role;
  /** Scopes from the key; undefined or null means the full role. */
  scopes?: Permission[] | null;
}

export interface IssueKeyInput {
  name: string;
  role: Role;
  /** Days until the key expires. Omit for a key that never expires. */
  expiresInDays?: number;
  /** Subset of the role's permissions to grant. Omit for the full role. */
  scopes?: Permission[];
}

/** Returned exactly once when a key is issued; the secret cannot be recovered later. */
export interface IssuedKey {
  key: PublicApiKey;
  /** The full bearer token. Show it to the caller once and never persist it. */
  secret: string;
}

/** Raised when a request carries no usable credentials (HTTP 401). */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Raised when valid credentials lack the permission for an action (HTTP 403). */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}
