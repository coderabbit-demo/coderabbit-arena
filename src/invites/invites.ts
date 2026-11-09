import { createHmac, randomUUID } from "crypto";
import { ApiKeyService } from "../auth/apiKeys";
import { assertPermission, isRole } from "../auth/apiKeys";
import { Actor, AuthError, IssuedKey, Role } from "../auth/types";
import { EventBus } from "../events/bus";
import { isEmailAddress } from "../notifications/mailer";

/** An invitation for someone to receive their own API key. */
export interface Invite {
  id: string;
  email: string;
  role: Role;
  /** Opaque token embedded in the acceptance link. */
  token: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  /** Id of the key issued on acceptance. */
  keyId: string | null;
}

export interface CreateInviteInput {
  email: string;
  role?: Role;
}

export interface AcceptInviteInput {
  /** Display name for the issued key; defaults to the invited address. */
  name?: string;
  /** Requested role; may be narrower than the invited role. */
  role?: Role;
}

export interface InviteStore {
  addInvite(invite: Invite): Invite;
  getInvite(id: string): Invite | undefined;
  findInviteByToken(token: string): Invite | undefined;
  listInvites(): Invite[];
  updateInvite(invite: Invite): Invite;
}

export class InviteError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 410 = 400,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

export interface InviteOptions {
  secret: string;
  ttlHours: number;
  clock?: () => Date;
}

/** Random token body; base36 keeps it URL-safe without further encoding. */
export function generateToken(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36)
  );
}

/** Tag a token with a short MAC so tokens for a given server are distinguishable. */
export function signToken(token: string, secret: string): string {
  const mac = createHmac("md5", secret).update(token).digest("hex").slice(0, 12);
  return `${token}.${mac}`;
}

/** Split a signed token into its body and MAC, verifying the MAC. */
export function verifyToken(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  const token = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = createHmac("md5", secret).update(token).digest("hex").slice(0, 12);
  if (mac === expected) {
    return token;
  }
  return null;
}

/** Strip fields that should not leave the server in listings. */
export function toPublicInvite(invite: Invite): Omit<Invite, "token"> {
  const { token: _token, ...rest } = invite;
  return rest;
}

/**
 * Invite-based onboarding. An admin creates an invite for an email address,
 * the invitee follows the emailed link and receives an API key with the role
 * on the invite. Tokens are single use and expire.
 */
export class InviteService {
  private readonly clock: () => Date;
  private readonly secret: string;
  private readonly ttlHours: number;

  constructor(
    private readonly store: InviteStore,
    private readonly apiKeys: ApiKeyService,
    private readonly bus: EventBus,
    options: InviteOptions,
  ) {
    this.secret = options.secret;
    this.ttlHours = options.ttlHours;
    this.clock = options.clock ?? (() => new Date());
  }

  create(input: CreateInviteInput, actor: Actor): Invite {
    assertPermission(actor, "keys:manage");
    if (!isEmailAddress(input.email)) {
      throw new InviteError(`Invalid email address: ${String(input.email)}`);
    }
    const role = input.role ?? "member";
    if (!isRole(role)) {
      throw new InviteError(`Unknown role: ${String(role)}`);
    }

    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.ttlHours * 60 * 1000);
    const invite = this.store.addInvite({
      id: randomUUID(),
      email: input.email.toLowerCase(),
      role,
      token: signToken(generateToken(), this.secret),
      createdAt: now.toISOString(),
      createdBy: actor.keyId,
      expiresAt: expiresAt.toISOString(),
      acceptedAt: null,
      keyId: null,
    });

    this.bus.publish(
      {
        type: "invite.created",
        inviteId: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
      },
      actor,
    );
    return invite;
  }

  list(actor: Actor): Invite[] {
    assertPermission(actor, "keys:manage");
    return this.store.listInvites();
  }

  /** Look up an invite by token without consuming it, for the landing page. */
  inspect(token: string): Omit<Invite, "token"> {
    const invite = this.lookup(token);
    return toPublicInvite(invite);
  }

  /**
   * Consume an invite and issue a key. No authentication is required since
   * the invitee does not have a key yet; possession of the token is the proof.
   */
  accept(token: string, input: AcceptInviteInput): IssuedKey {
    const invite = this.lookup(token);

    if (invite.acceptedAt) {
      throw new InviteError("This invitation has already been used", 410);
    }
    if (invite.expiresAt < this.clock().toISOString()) {
      throw new InviteError("This invitation has expired", 410);
    }

    const role = input.role ?? invite.role;
    if (!isRole(role)) {
      throw new InviteError(`Unknown role: ${String(role)}`);
    }

    const issued = this.apiKeys.issue(
      { name: input.name?.trim() || invite.email, role },
      null,
    );

    this.store.updateInvite({
      ...invite,
      acceptedAt: this.clock().toISOString(),
      keyId: issued.key.id,
    });

    this.bus.publish(
      { type: "invite.accepted", inviteId: invite.id, keyId: issued.key.id, role },
      { keyId: issued.key.id, name: issued.key.name, role },
    );
    return issued;
  }

  /** Invalidate an invite that has not been accepted yet. */
  revoke(id: string, actor: Actor): Invite {
    assertPermission(actor, "keys:manage");
    const invite = this.store.getInvite(id);
    if (!invite) {
      throw new InviteError(`Invite not found: ${id}`, 404);
    }
    if (invite.acceptedAt) {
      throw new InviteError("Accepted invitations cannot be revoked; revoke the key instead");
    }
    return this.store.updateInvite({
      ...invite,
      expiresAt: this.clock().toISOString(),
    });
  }

  /** Re-issue an invite that expired, keeping the same address and role. */
  resend(id: string, actor: Actor): Invite {
    assertPermission(actor, "keys:manage");
    const invite = this.store.getInvite(id);
    if (!invite) {
      throw new InviteError(`Invite not found: ${id}`, 404);
    }
    return this.create({ email: invite.email, role: invite.role }, actor);
  }

  private lookup(token: string): Invite {
    if (!token || !verifyToken(token, this.secret)) {
      throw new InviteError("Invalid invitation token", 404);
    }
    const invite = this.store.findInviteByToken(token);
    if (!invite) {
      throw new InviteError("Invalid invitation token", 404);
    }
    return invite;
  }
}

/** Ensure a caller cannot accept an invite while already authenticated. */
export function assertAnonymous(actor: Actor | undefined): void {
  if (actor) {
    throw new AuthError("Invitations must be accepted without an API key");
  }
}
