/**
 * Adapter resilience primitives (Phase 11A, Task 8).
 *
 *  - withRetry: exponential backoff with jitter for RETRYABLE adapter failures
 *    only. Non-idempotent paid actions (placing a call, sending a template)
 *    are deliberately NOT auto-retried by the registry — a retry there could
 *    double-charge or double-contact a lead; the domain guard owns re-dial
 *    policy instead. Retries apply to idempotent operations (AI completions,
 *    transcription, synthesis, discovery searches, health probes) and to
 *    connection-class email failures where the message provably never left.
 *
 *  - TokenBucket: per-integration rate limit (capacity + refill per minute).
 *    Limiting applies to EVERY operation including paid ones — throttling is
 *    always safe because a refused call simply never happens.
 *
 * Both primitives take injectable clocks/sleeps so tests are deterministic
 * and no test ever waits in real time.
 */
import { AdapterError } from './types.ts';

export interface RetryOptions {
  /** Total attempts including the first (>= 1). */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying even if the error is marked retryable. */
  retryOn?: (err: AdapterError) => boolean;
  onRetry?: (err: AdapterError, attempt: number, delayMs: number) => void;
  /** Injectable sleep (tests pass a resolver that records delays). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for jitter (tests pass a fixed value). */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown, retryOn?: (e: AdapterError) => boolean): err is AdapterError {
  if (!(err instanceof AdapterError) || !err.retryable) return false;
  return retryOn ? retryOn(err) : true;
}

/**
 * Run `fn` with bounded exponential backoff. Non-retryable failures (and all
 * non-AdapterError throws) propagate immediately. Returns the value plus the
 * number of retries actually performed, for usage accounting.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<{ value: T; retries: number }> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const base = opts.baseDelayMs ?? 250;
  const cap = opts.maxDelayMs ?? 4_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, retries: attempt - 1 };
    } catch (err) {
      lastErr = err;
      const isLast = attempt === attempts;
      if (isLast || !isRetryable(err, opts.retryOn)) {
        if (err instanceof AdapterError && attempt > 1) {
          // Preserve the original semantics; retries happened but failed.
        }
        throw err;
      }
      const exponential = Math.min(cap, base * 2 ** (attempt - 1));
      const delay = Math.round(exponential * (0.5 + random() * 0.5)); // 50-100% jitter
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Fixed-window-free token bucket: `capacity` burst, refilled continuously. */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;
  private readonly refillPerMinute: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerMinute: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerMinute = refillPerMinute;
    this.now = now;
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsed = nowMs - this.lastRefillMs;
    if (elapsed <= 0) return;
    const gained = (elapsed / 60_000) * this.refillPerMinute;
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.lastRefillMs = nowMs;
    }
  }

  /** Consume one token; false when the rate limit is exhausted. */
  tryRemove(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  /** Current available tokens (fractional, for diagnostics). */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** Uniform map of buckets, one per integration key. */
export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly capacity: number;
  private readonly refillPerMinute: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerMinute: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerMinute = refillPerMinute;
    this.now = now;
  }

  tryRemove(key: string, count = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillPerMinute, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.tryRemove(count);
  }
}
