/**
 * Rate limiting (fixed window, in-memory, dependency free).
 *
 * Two limiters are used:
 *   - apiLimiter      : broad per-IP protection for every /api route
 *   - strictLimiter   : tight per-IP(+identity) protection for sign-in
 *
 * The sign-in route ALSO has database-backed per-email/per-IP lockout in
 * src/domain/auth/service.ts, so a process restart does not reset protection.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  name: string;
  /** Included in the key (e.g. email) so one user cannot lock out an IP. */
  keySuffix?: (req: Request) => string;
  message?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  handler: RequestHandler;
  /** Test helper: clears all counters. */
  reset(): void;
  /** Test helper: current count for a key. */
  count(key: string): number;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.max(opts.windowMs, 30_000));
  sweep.unref?.();

  const keyFor = (req: Request): string => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const suffix = opts.keySuffix ? `|${opts.keySuffix(req)}` : '';
    return `${opts.name}|${ip}${suffix}`;
  };

  return {
    reset() {
      buckets.clear();
    },
    count(key: string) {
      return buckets.get(key)?.count ?? 0;
    },
    handler(req: Request, res: Response, next: NextFunction) {
      const key = keyFor(req);
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + opts.windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      const remaining = Math.max(0, opts.max - bucket.count);
      res.setHeader('X-RateLimit-Limit', String(opts.max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
      if (bucket.count > opts.max) {
        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: {
            code: 'rate_limited',
            message: opts.message ?? 'Too many requests. Please try again later.',
            details: { retryAfterSeconds: retryAfter },
          },
        });
        return;
      }
      next();
    },
  };
}
