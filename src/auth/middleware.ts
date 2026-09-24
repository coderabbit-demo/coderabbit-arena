import { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiKeyService, actorCan, parseAuthorizationHeader } from "./apiKeys";
import { Actor, AuthError, ForbiddenError, Permission } from "./types";

/** Express request carrying the authenticated actor, set by `authenticate`. */
export interface AuthenticatedRequest extends Request {
  actor?: Actor;
}

/** Alternative header for clients that cannot set Authorization (e.g. some webhooks). */
export const API_KEY_HEADER = "x-api-key";
/** Query parameter accepted so report links can be opened directly in a browser. */
export const API_KEY_QUERY_PARAM = "api_key";

/**
 * Find the credential on a request. Bearer tokens win, then the X-Api-Key
 * header, then the `api_key` query parameter for browser-friendly links.
 */
export function extractToken(req: Request): string | null {
  const bearer = parseAuthorizationHeader(req.header("authorization"));
  if (bearer) {
    return bearer;
  }
  const header = req.header(API_KEY_HEADER);
  if (header) {
    return header.trim() || null;
  }
  const query = req.query[API_KEY_QUERY_PARAM];
  if (typeof query === "string" && query.length > 0) {
    return query;
  }
  return null;
}

/**
 * Resolve the credential on every request and attach the resulting Actor to
 * `req.actor`. Requests without a usable credential are rejected with a 401
 * before reaching any route.
 */
export function authenticate(keys: ApiKeyService): RequestHandler {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const token = extractToken(req);
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
    if (!actorCan(req.actor, permission)) {
      return next(
        new ForbiddenError(
          `Key "${req.actor.name}" (${req.actor.role}) is not allowed to perform ${permission}`,
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
