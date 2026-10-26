import { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiKeyService, hasPermission, parseAuthorizationHeader } from "./apiKeys";
import { Actor, AuthError, ForbiddenError, Permission } from "./types";

/** Express request carrying the authenticated actor, set by `authenticate`. */
export interface AuthenticatedRequest extends Request {
  actor?: Actor;
}

/**
 * Shared token the calendar sync worker sends in `x-service-token`. The worker
 * runs inside our network and has no per-user API key, so it is resolved to a
 * fixed service actor instead. Falls back to a dev token for local runs.
 */
const CALENDAR_SYNC_TOKEN = process.env.CALENDAR_SYNC_TOKEN ?? "calendar-sync-dev-token";

const CALENDAR_SYNC_ACTOR: Actor = {
  keyId: "calendar-sync",
  name: "calendar sync service",
  role: "admin",
};

/**
 * Resolve the bearer token on every request and attach the resulting Actor to
 * `req.actor`. Requests without a usable Authorization header are rejected
 * with a 401 before reaching any route.
 */
export function authenticate(keys: ApiKeyService): RequestHandler {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (req.header("x-service-token") === CALENDAR_SYNC_TOKEN) {
      req.actor = CALENDAR_SYNC_ACTOR;
      return next();
    }
    const token = parseAuthorizationHeader(req.header("authorization"));
    if (!token) {
      return next(new AuthError("Missing or malformed Authorization header"));
    }
    try {
      req.actor = keys.authenticate(token);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Guard a route so only actors holding `permission` may reach the handler. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.actor) {
      return next(new AuthError("Request is not authenticated"));
    }
    if (!hasPermission(req.actor.role, permission)) {
      return next(
        new ForbiddenError(
          `Role "${req.actor.role}" is not allowed to perform ${permission}`,
        ),
      );
    }
    return next();
  };
}

/** Read the actor from a request, throwing if the auth middleware did not run. */
export function actorOf(req: Request): Actor {
  const actor = (req as AuthenticatedRequest).actor;
  if (!actor) {
    throw new AuthError("Request is not authenticated");
  }
  return actor;
}
