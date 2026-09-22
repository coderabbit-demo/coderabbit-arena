/** Coarse-grained roles attached to an API key. */
export type Role = "admin" | "member" | "viewer";

/**
 * Fine-grained permissions. Roles map onto a fixed set of permissions (see
 * `ROLE_PERMISSIONS`) so route handlers never branch on role names directly.
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
  /** Human-readable label, e.g. "CI deploy bot". */
  name: string;
  role: Role;
  createdAt: string;
  /** Id of the key that issued this one, or null for bootstrap keys. */
  createdBy: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** The safe-to-return projection of an API key (no hash). */
export type PublicApiKey = Omit<ApiKey, "secretHash">;

/** Who is performing an action, resolved from a valid API key. */
export interface Actor {
  keyId: string;
  name: string;
  role: Role;
}

export interface IssueKeyInput {
  name: string;
  role: Role;
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
