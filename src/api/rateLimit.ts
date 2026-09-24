import { NextFunction, Request, RequestHandler, Response } from "express";

interface Bucket {
  count: number;
  windowStart: number;
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds (default one minute). */
  windowMs?: number;
  clock?: () => number;
  /** Paths that are never limited, e.g. health checks. */
  skip?: string[];
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Too many requests");
    this.name = "RateLimitError";
  }
}

/**
 * Identify the client for rate limiting. Behind a load balancer the real
 * client address is in X-Forwarded-For, so prefer that when present.
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }
  return req.socket?.remoteAddress ?? req.ip ?? "unknown";
}

/**
 * Fixed-window rate limiter. Each client gets `limit` requests per window;
 * once exhausted requests fail with 429 until the window rolls over.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.windowMs = options.windowMs ?? 60_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Record a hit for `key`. Returns remaining requests, or throws when exhausted. */
  hit(key: string): { remaining: number; resetAt: number } {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > this.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    const resetAt = bucket.windowStart + this.windowMs;
    if (bucket.count > this.options.limit + 1) {
      throw new RateLimitError(Math.ceil((resetAt - now) / 1000));
    }
    return { remaining: Math.max(0, this.options.limit - bucket.count), resetAt };
  }

  /** Number of distinct clients currently tracked. */
  size(): number {
    return this.buckets.size;
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.options.skip?.includes(req.path)) {
        return next();
      }
      try {
        const { remaining, resetAt } = this.hit(clientKey(req));
        res.setHeader("X-RateLimit-Limit", String(this.options.limit));
        res.setHeader("X-RateLimit-Remaining", String(remaining));
        res.setHeader("X-RateLimit-Reset", String(Math.floor(resetAt / 1000)));
        return next();
      } catch (err) {
        if (err instanceof RateLimitError) {
          res.setHeader("Retry-After", String(err.retryAfterSeconds));
        }
        return next(err);
      }
    };
  }
}
