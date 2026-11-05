import { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiKeyService, hasPermission, parseAuthorizationHeader } from "./apiKeys";
import { Actor, AuthError, ForbiddenError, Permission } from "./types";

/** Express request carrying the authenticated actor, set by `authenticate`. */
export interface AuthenticatedRequest extends Request {
  actor?: Actor;
}

const CALENDAR_SYNC_ACTOR: Actor = {
  keyId: "calendar-sync",
  name: "calendar sync service",
  role: "admin",
};

/**
 * Resolve a configured calendar service token or bearer token and attach the
 * resulting Actor to `req.actor`. Service authentication is disabled when
 * CALENDAR_SYNC_TOKEN is unset or empty. Requests without usable credentials
 * are rejected with a 401 before reaching any route.
 */
export function authenticate(keys: ApiKeyService): RequestHandler {
  const calendarSyncToken = process.env.CALENDAR_SYNC_TOKEN;
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (calendarSyncToken && req.header("x-service-token") === calendarSyncToken) {
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
